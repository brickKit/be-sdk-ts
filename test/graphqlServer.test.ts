/**
 * newGraphQLServer 的横切能力——阶段三计划 Task 2 明确要求的回归测试：
 * "故意发一个 depth=6 的查询，断言被拒绝"。
 *
 * ⚠️ 用 `yoga.fetch()` 直接测（whatwg-node 的标准测试方式），不起真实
 * 端口——这条和 be-sdk-python 用 FastAPI `TestClient` 是同一个思路。
 *
 * ⚠️⚠️ **深度测试不能发裸查询文本**，这是写这份文件时真机试出来的：
 * `persisted_queries_only: true` 一旦开启，`usePersistedOperations`
 * 会在深度检查**之前**先把任何不认识的查询拒绝掉（`PersistedQueryOnly`
 * 错误），裸查询永远走不到深度检查那一步。这恰好符合生产实际——前端
 * 一旦切到 persisted operations，就不会再发裸查询文本。所以要测的是
 * "**已经在白名单里、但太深的查询依然被拒**"，不是"裸查询被拒"（那条
 * 由另一条测试单独覆盖）。做法是把深查询也注册进 `getPersistedOperation`
 * 的假注册表，再用它的哈希去请求。
 */

import { describe, expect, it } from "vitest";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { Registry } from "@prometheus-io/client";
import { newGraphQLServer } from "../src/graphqlServer.js";
import { PUBLIC, requirePermission } from "../src/authz.js";
import type { Runtime } from "../src/runtime.js";

// ⚠️ 最小假 Runtime——tracer/logger/registry 都要能被真的调用
// （graphqlServer.ts 会真的 tracer.startSpan()、logger.info()、注册
// Prometheus 指标），所以不能全部留 undefined，要给可用的最小实现。
// `config` 在本文件测的范围里从未被读取，用 `unknown as` 占位不用假装
// 造一个完整 Config。
function fakeRuntime(): Runtime {
  return {
    componentId: "infra/bff-mobile",
    componentVersion: "0.0.0-test",
    config: undefined as unknown as Runtime["config"],
    logger: { info: () => {} } as unknown as Runtime["logger"],
    tracer: { startSpan: () => ({ end: () => {} }) } as unknown as Runtime["tracer"],
    meter: {} as unknown as Runtime["meter"],
    registry: new Registry(),
    httpPort: 8500,
  };
}

const typeDefs = /* GraphQL */ `
  type Nested {
    value: String
    child: Nested
  }
  type Query {
    public: String
    secret: String
    nested: Nested
  }
`;

// 构建期产物的模拟：真实项目里这份表由前端构建时生成、随 BFF 镜像发布
// （infra-bff-mobile.md §9-3）。
const REGISTERED_OPS = new Map<string, string>([
  ["public-hash", "{ public }"],
  ["secret-hash", "{ secret }"],
  ["shallow-hash", "{ nested { child { value } } }"], // 2 层，在限制内
  [
    "deep-hash",
    // nested -> child ×5 = 6 层深，超过 max_depth: 5
    "{ nested { child { child { child { child { child { value } } } } } } }",
  ],
]);

function buildYoga() {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: {
        public: requirePermission(PUBLIC, async () => "ok"),
        secret: requirePermission("erp.sales.view", async () => "secret"),
        nested: requirePermission(PUBLIC, async () => ({ value: "0" })),
      },
      Nested: {
        child: (parent: { value: string }) => ({
          value: String(Number(parent.value) + 1),
        }),
      },
    },
  });

  return newGraphQLServer(fakeRuntime(), {
    schema,
    getPersistedOperation: (key: string) => REGISTERED_OPS.get(key) ?? null,
  });
}

async function postRaw(yoga: ReturnType<typeof buildYoga>, query: string) {
  return yoga.fetch("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

async function postPersisted(yoga: ReturnType<typeof buildYoga>, hash: string) {
  return yoga.fetch("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  });
}

describe("newGraphQLServer", () => {
  it("/healthz 返回 200，不查任何依赖", async () => {
    const yoga = buildYoga();
    const res = await yoga.fetch("http://localhost/healthz");
    expect(res.status).toBe(200);
  });

  it("非 Persisted Operation 的任意裸查询被拒绝（§11.4.3 persisted_queries_only）", async () => {
    const yoga = buildYoga();
    const res = await postRaw(yoga, "{ public }");
    const json = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(json.errors).toBeDefined();
    expect(json.errors!.some((e) => /PersistedQueryOnly/i.test(e.message))).toBe(true);
  });

  it("白名单里 depth=6 的查询依然被拒绝（§11.4.3 max_depth: 5，白名单不能绕过深度限制）", async () => {
    // ⚠️ 真机验证过的一处 Yoga 行为，写清楚不装作没发生：depth 校验发生
    // 在**验证阶段**（`validate()`），graphql-armor 抛的是 graphql-js
    // 原生 `GraphQLError`，但 Yoga 默认的 `maskedErrors` 仍然把它替换成
    // 通用的 "Unexpected error."（`code: INTERNAL_SERVER_ERROR`）——
    // 与 authz.ts 的 403（走 `createGraphQLError`，故意不掩盖）不是同一
    // 条路径。所以这里不能断言消息里含"depth"，只能断言**请求确实被拒、
    // 没有任何数据返回**——这本身已经是这条防线在生效的完整证据。
    const yoga = buildYoga();
    const res = await postPersisted(yoga, "deep-hash");
    const json = (await res.json()) as {
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
      data?: unknown;
    };
    expect(json.errors).toBeDefined();
    expect(json.errors![0]!.extensions?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(json.data).toBeUndefined();
  });

  it("白名单里 depth 在限制内的查询正常执行", async () => {
    const yoga = buildYoga();
    const res = await postPersisted(yoga, "shallow-hash");
    const json = (await res.json()) as { errors?: unknown; data?: { nested?: unknown } };
    expect(json.errors).toBeUndefined();
    expect(json.data?.nested).toBeDefined();
  });

  it("Persisted Operation 里 PUBLIC 字段放行，非 PUBLIC 字段拒绝", async () => {
    const yoga = buildYoga();

    const publicRes = await postPersisted(yoga, "public-hash");
    const publicJson = (await publicRes.json()) as { data?: { public?: string } };
    expect(publicJson.data?.public).toBe("ok");

    const secretRes = await postPersisted(yoga, "secret-hash");
    const secretJson = (await secretRes.json()) as {
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    // ⚠️ 与上面的深度限制不同：403 走 createGraphQLError，Yoga 认得出它
    // 是"原生"GraphQLError，不会被 maskedErrors 替换掉——客户端应该
    // 看得到真实原因，"你没有权限"不是要隐藏的内部错误（authz.ts 里
    // 写清楚了这条判据）。
    // ⚠️ 阶段三 Task 5 之后：这里测的 fakeRuntime 没有配 iamJwksUrl，
    // requirePermission 退化成阶段二遗留的 fail-closed stub——消息文本
    // 与 be-sdk-go/be-sdk-python 同一路径的措辞对应，见 authz.ts。
    expect(secretJson.errors).toBeDefined();
    expect(secretJson.errors!.some((e) => /权限判定尚未配置/.test(e.message))).toBe(true);
    expect(secretJson.errors!.some((e) => e.extensions?.code === "FORBIDDEN")).toBe(true);
  });
});

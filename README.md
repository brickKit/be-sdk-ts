# be-sdk-ts

TypeScript 横切基础库（总纲 §4 SOP-L，**只有一半能力**）。**不是 brickKit 组件**，也**不是公共 model 包**——零业务逻辑、零组件 model、零组件间引用。它是 `be-acceptance` 铁律六 import 扫描的白名单之一（另两个是 `be-sdk-go`、`be-sdk-python`）。

⚠️ **只有一半，是设计书 §5.10 明说的**：`infra-bff-mobile` 严禁直连 DB（§6.5 铁律），`frontend-*` 更没有后端库可言。所以本仓库**没有** `withTx`、**没有**冷热路由（`batchGet` 归档路由）——这两样在 Go/Python 版里都是"最难查的雷"防线，TS 组件天生不碰数据库就不需要它们。**多出来的一条**：GraphQL 侧的深度/复杂度限制与 Persisted Operations（§11.4.3），这是 Go/Python 两份 SDK 都没有的东西。

## 它替 TS 组件挡住的坑

| 能力 | 文件 | 挡住的坑 |
|---|---|---|
| 组件地址剥 scheme | `endpoint.ts` | 直接把带 scheme 的地址传给 gRPC 客户端连不上，报错指向名称解析（导读第 1 条） |
| GraphQL 深度/复杂度限制 | `graphqlServer.ts` | 恶意或手滑的深层嵌套查询把下游打满——GraphQL 的经典 DoS 面（§11.4.3） |
| Persisted Operations | `graphqlServer.ts` | 允许任意查询文本 = 允许客户端发任意查询，弱网下还要传完整查询文本 |
| DataLoader 必须 per-request | `dataloader.ts` | 全局单例会跨请求缓存命中，**A 用户看到 B 用户的数据**，且单请求测试测不出来 |

## 现状（阶段三 Task 2）

`Config`（含 camelCase→SCREAMING_SNAKE_CASE 转换）、`Runtime`/`Module` 类型、`runStandalone`、`newGraphQLServer`、`endpoint`——真实实现，18 条测试全绿（含"depth=6 被拒绝""白名单不能绕过深度限制"两条阶段三计划明确要求的回归测试，都做过故意改坏代码验证测试真的会红）。

`otel.ts`/`logging.ts`/`metrics.ts` 现在只有签名 + `throw new Error("阶段三 Task 2 后续 TDD 补")`。**调用它们会抛异常，这是预期行为**，对齐 `be-sdk-go`/`be-sdk-python` 同一批文件的处理方式——留给后续用 TDD 补上，在 `infra-bff-mobile` 真正需要它们（Task 11）之前补齐。

`client.ts` 按 `be-sdk-go`/`be-sdk-python` 同一条判据写：`userClient`/`systemClient` 两种身份透传，签名不变。

## 现状（阶段三 Task 5，权限判定真正上线）

`requirePermission`/`scopeOf` 从 Task 2 的 fail-closed stub 换成真实判定——与 `be-sdk-go`/`be-sdk-python` 同一批上线，判定链逐字对应（设计书 §14.1.6 第 3 步、§14.1.9），只有两处必要差异（见 `authz.ts`/`scope.ts` 模块文档）：① 判据从"路由注册函数强制要求权限键参数"平移成"每个字段 resolver 必须经过 `requirePermission` 包装"（GraphQL 没有路由，只有字段）；② Go/Python 从 `context.Context`/contextvar 隐式取当前请求，这里改成 GraphQL resolver 的 `context` 参数显式携带——`requirePermission` 验签成功后把算好的 `ScopeFilter` 挂到 `context` 对象上（用 `Symbol` 键，避免撞名），`scopeOf(context)` 从同一个对象读回。

- **JWT 本地验签**（`jwtVerify.ts`）：用 [`jose`](https://github.com/panva/jose)（决策 32：有现成的就用现成的）——`createRemoteJWKSet` 自带 JWK Set 缓存与刷新，`jwtVerify` 本身就是异步的，不像 Python 版需要 `asyncio.to_thread` 包一层同步库。只认 RS256；`requiredClaims: ["sub", "iat"]` 交给 `jose` 自己校验并抛 `JWTClaimValidationFailed`，不手写判断（同 be-sdk-python 真机测试发现的教训：库自己已经做了，手写分支是死代码）。`infra-iam-casdoor` 要到阶段三 Task 7 才建仓库，测试自己起一对 RSA 密钥 + 一个真实绑定端口的 `node:http` 服务器当 JWKS 端点，加密运算是真的，只是身份是测试夹具。
- **bundle 轮询**（`bundle.ts`）：15 秒条件 GET `authzBundleUrl`（`If-None-Match`，未变化 304 不重新解析），一个自我重排的 `setTimeout` 链条，fail-static（单次拉取失败沿用内存里旧内容）。⚠️ 不用锁——单线程事件循环下 `fetchOnce` 末尾对几个字段的赋值之间没有 `await`，不可能被打断到一半。有一条测试真等 15 秒验证"改角色分配不重启组件也能生效"。
- **`AUTHENTICATED` 新哨兵值**：阶段三 Task 4 写 `infra-authz` 时发现的真实缺口——`PUBLIC`/具体权限键两档之间缺"已登录即可，不需要权限键"这一档，与 Go/Python 版逐字对应。
- **401/403/503 通过 `createGraphQLError` 的 `extensions.http.status`/`extensions.http.headers` 真的映射成 HTTP 响应状态码/响应头**（真机核对过 `graphql-yoga` 的 `getResponseInitByRespectingErrors` 源码），`token_stale` 场景的 `WWW-Authenticate` 响应头就是这样透出去的。
- **`scopeOf()` 是纯函数**（§14.2.4）：`prefix`/`exact`/`owner` 永远从同一份 Claims 的 `deptPath`/`sub` 填。⚠️ 取不到时**不能**返回默认的 `ScopeFilter`——§14.2.4 的 SQL 约定"空字符串表示不限"，零值会被下游解读成放行一切，是 fail-open 不是 fail-closed；改成抛异常，让编程错误在联调阶段就现形（与 Go/Python 版同一处教训，各自独立发现）。
- 真机验证：起了本地 `infra-authz` 容器，轮询客户端直接打它真实的 `GET /authz/bundle`，确认认得出自举种子数据 `authz_admin`/`infra.authz.admin`。

## 一处会话内发现并推翻的坑：GraphQL 权限错误默认会被 Yoga 掩盖

Yoga 的 `maskedErrors`（默认开启）只放行 `instanceof GraphQLError` 的错误（`isOriginalGraphQLError`）——用裸 `Error` 子类抛权限错误，客户端只会看到通用的 `"Unexpected error."`，完全看不出是权限问题还是服务真的挂了。`authz.ts` 的判据是：**403 属于"该让调用方看见的正常业务语义"，不是要隐藏的内部错误**，所以用 `createGraphQLError`（`graphql-yoga` 导出）造错误，不用裸 `Error`。

⚠️ **`graphql-armor` 的深度/复杂度校验走的是验证阶段（`validate()`），即使它抛的也是原生 `GraphQLError`，仍然会被掩盖成 `"Unexpected error."`**——这与 authz 的 403 不是同一条路径，本仓库的测试（`test/graphqlServer.test.ts`）没有强行改这条默认行为，而是断言"确实被拒、没有数据返回"这个可观察到的事实，不断言消息文本。

## 为什么是 GraphQL Yoga + graphql-armor（真查证过，不是凭印象选的）

| 决定 | 依据 |
|---|---|
| GraphQL Yoga 而不是 Apollo Server | 内置 Persisted Operations 插件明确支持"构建期注册表 + 拒绝未知哈希"这种 safelisting 形态（与 Apollo 的运行时 APQ 是两回事），插件形态直接对得上 §11.4.3 那三条限制 |
| `@escape.tech/graphql-armor` 而不是自己写深度/复杂度计算 | 官方维护的一组现成防护插件，`maxDepth`/`costLimit` 配置直接对应 §11.4.3 的两个数字，不用自己写 AST 遍历 |
| `@prometheus-io/client` 而不是 `prom-client` | `prom-client` 已被其官方标记 deprecated、替换为此包；后者是 Prometheus 官方团队维护、依赖 `@opentelemetry/api`（与本仓库已有的 OTel 依赖天然契合），API 形状（`Counter`/`Histogram`/`Registry` 的 `name`/`help`/`labelNames`/`registers`）与 `prom-client` 基本一致，不用大改调用点 |

## 用法

```ts
// module.ts
export async function newModule(rt: Runtime): Promise<Module> {
  const schema = makeExecutableSchema({ typeDefs, resolvers: {
    orders: requirePermission("erp.sales.view", async (_, args, ctx) => {
      const loader = createBatchGetLoader(ids => batchGetOrders(ids)); // per-request！
      return loader.load(args.id);
    }),
  }});
  const yoga = newGraphQLServer(rt, { schema, getPersistedOperation });
  return { httpHandler: yoga };
}
```

```ts
// main.ts 只有几行
import { runStandalone } from "@brickkit/be-sdk-ts";
import { newModule } from "./module.js";

void runStandalone(newModule);
```

## 依赖

`graphql-yoga` / `@graphql-tools/schema` / `@graphql-yoga/plugin-persisted-operations` / `@escape.tech/graphql-armor`（GraphQL 层）、`@grpc/grpc-js`（客户端调后端组件）、`dataloader`、`@opentelemetry/api` + `@opentelemetry/sdk-node`、`@prometheus-io/client`、`pino`、`jose`（JWT/JWKS 验签）。版本精确锁定（`package.json` 里没有 `^`/`~`），TypeScript `5.9.3`（不是刚发布的 7.0 原生编译器重写版——生态兼容性还没跟上，等它稳定后再评估要不要换）。

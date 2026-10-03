[English](README.md) · [中文](README.zh.md)

# be-sdk-ts

BrickEnterprise 组件协议 **be-protocol 1.0**（`brickKit/be-protocol`，钉在 `v1.0.0-rc.1`）的官方 TypeScript 运行时。用它写的组件在线上满足协议的要求，由 `brickKit/be-acceptance` 的黑盒套件 `conformance/component/` 核对。它不是 brickKit 组件，不含业务逻辑。

名词与 `be-sdk-go`、`be-sdk-python` 相同，写法是 camelCase：`defineComponent`、`main`、`Module`、`Runtime`、`rt.store()`、`store.tx`、`tx.publish`、`access()`、`rt.conn` / `rt.client`、`rt.userHttp`、`beError`。

## 一个组件

```ts
import { main, defineComponent, PUBLIC, access, beError } from "@brickkit/be-sdk-ts";

main(defineComponent({
  id: "erp/sales",
  migrations: "migrations",          // node-pg-migrate 的 SQL 文件 + lifecycle.yaml
  contracts: "contracts",            // errors.yaml、events/*.events.json
  create: async (rt) => ({
    http: (r) => {
      r.post("/orders", "erp.sales.create", async (req) => {
        const id = await rt.store().tx(async (tx) => {
          // … 用 tx.query(sql, params, zodRow?) 做业务写入 …
          await tx.publish({ subject: "sales.order.created.v1", aggregateId: orderId, version: 1, payload });
          return orderId;
        });
        return { id };
      }, { timeoutMs: 15_000 });
      r.get("/me", PUBLIC, async () => ({ ok: true }));
    },
    grpc: (s) => s.addService(SalesServiceService, impl, { schema: protoMetadata }),
    events: {
      publishes: ["sales.order.created.v1"],
      subscribe: [{ subject: "finance.credit.rejected.v1", apply: async (tx, ev) => { /* 只做本地写 */ } }],
    },
  }),
}));
```

镜像的入口（P1.1）：不带参数起服务；`migrate up | down <n> | status` 跑迁移（`component.yaml` 写 `migration.command: [node, main.js, migrate, up]`）；`job run <name>` 先占位（P14.8，见"还没做"）。退出码：0 正常停机或迁移完成（库比镜像新时也是 0），1 初始化或迁移失败，64 不认识的参数或任务，78 配置错误（每个键一行 JSON）。

## 实现了什么

| 方面 | 条款 | 说明 |
|---|---|---|
| 进程 | P1.1–P1.8、P1.13 | 启动顺序、`/healthz`、`/readyz`（bundle、`db_identity`、`migrations`，满足后锁定）、SIGTERM 在 `SHUTDOWN_GRACE` 内收尾、后台工作受监督（1 s → 5 min）、双栈监听 |
| 配置 | P2 | 只读 `configSchema` 里的键，按目录（`schemas/config-keys.yaml`）严格类型，一次报出全部错误，`_FILE` 密钥按修改时间和大小重读，`*_ENDPOINT` 与族地址（`$endpoint:` 的值，不做端口算术）；服务入口从不打开 `PG_OWNER_PASSWORD_FILE` |
| HTTP | P3.1–P3.6、P3.10、P3.12 | 每个成员一个 Fastify 5 实例；`headersTimeout` 5000 + `connectionsCheckingInterval` 1000、`requestTimeout` 30000、`keepAliveTimeout` 120000、`bodyLimit` 1 MiB、`handlerTimeout` = 路由截止时间，答 504 |
| 错误 | P4 | problem+json、gRPC 状态码 + `google.rpc` 详情、转述依赖的 reason、`errors-be.yaml` 的 36 个 reason、依赖不可达统一为 `DEPENDENCY_UNAVAILABLE` 带 `metadata.dependency`、槽位族成员用 `Spec.errorDomain` |
| 身份与授权 | P5、P6.1–P6.10、P6.12–P6.15 | JWT（RS256/ES256/EdDSA、`typ=access`、iss/aud/exp/iat/jti、JWKS 缓存）、bundle `authz/2.x` 与 `infra.authz.changed.v1` 的 poke、EVALUATION E1–E12（62/62 判定向量）：`access().has` / `.scope(t)`（规范谓词，`sql(cols)` / `branches(cols)`）/ `.can` / `.check(tx, …)`（ACL 投影）/ `.require`（看不见答 404）/ `.explain` / `.mask` / `.checkWritable` / `.checkSortable` / `.rowActions`；`Spec.resources` 建投影、以 `be.authz.changes` 拉取（410 用快照重建）、挂 `_authz/check` 与 `_authz/explain`；`tx.syncRelation` |
| 系统面 | P7 | 服务端拦截链、从 ts-proto `protoMetadata` 读批量上限、按依赖复用 channel、按 `idempotency_level` 生成重试配置、出站截止时间、64 并发舱壁 |
| 出站 HTTP | P8 | `rt.userHttp(dep)` 转发调用者的 token；`rt.externalHttp(name)` 不转发任何内部头；事务里两者都拒绝 |
| 数据库 | P10 | `Store` / `Tx`、`SET LOCAL` 块、`/* be:<schema> */` 前缀加未命名语句、超时、重试、SQLSTATE 映射、成员连接预算、启动探测 |
| 迁移 | P11.1–P11.3 | 属主登录、按 schema 的锁、状态表 `pgmigrations_<schema>` / `besdk_migrations_<schema>`、平台迁移（参考 DDL）、outbox 分区窗口、流与 durable |
| 事件 | P12 | outbox、泵（等 PubAck）、JetStream durable 只建不改、运行时侧的重投与死信、聚合流游标、因果与跳数 |
| 幂等 | P13 | `idempotent(tx, cmd, run)`、`tx.idemClaim/Complete/Release/Lookup`、JCS 指纹、调用方命名空间、30 天有效（`idempotency/` 向量全部通过） |
| 后台工作 | P14 | `Module.jobs`（every / singleton / cron）、`workers`（队列，`tx.enqueue`）、`reconcilers`；`JOBS_OVERRIDES`、`be.cleanup`、`job run <name>`、`GET _ops/jobs`、P14.3 的指标 |
| 生命周期 | P16（P0：热 / 温） | `migrations/lifecycle.yaml` v1 与 `DATA_LIFECYCLE`、迁移时建分区窗口（P16.10 命名）、`be.lifecycle`（提前建分区、platform / queue 分区到期、封存与摘要链）、`tx.seal`、`_lifecycle/*`（units、verify、holds；其余答 501） |
| 可观测 | P18（部分）、P20 | 每成员一个 TracerProvider 和 MeterProvider（`rt.meter` 在 `/metrics` 导出）、共享导出器、W3C 传播器、`service.namespace`、`deployment.environment.name` = `DEPLOY_ENV`、带脱敏和 2 KiB 上限的 JSON 日志、带 `component` 的 `be_` 指标、`/_be/info` |
| 移动端 BFF | P4.5 | `mountGraphQL`（持久化查询、深度与成本上限）、`guard(key, resolver)`、`createBatchGetLoader` |

## 迁移目录

只放 `*.sql` 和 `lifecycle.yaml`。文件名以数字开头（`0001_create-orders.sql`）；文件里有 `-- Up Migration` 段和可选的 `-- Down Migration` 段（node-pg-migrate 的 SQL 格式）；每个文件一个事务，第一行写 `-- be:no-transaction` 的除外（单独一条 `CREATE INDEX CONCURRENTLY`，P11.4）。名字一律不带限定（P11.2）。

## 这个运行时的说明

- **grpc-js** 做不到服务端 keepalive 强制（`MinTime`，P7.5），靠客户端守 P7.6。它的重试预算按（进程，目标）共享、重新解析时不回满（P7.8）：TS 外壳里调同一个依赖的成员共用一份。
- **`rt.client(Ctor, dep, protoMetadata)`** 要传生成代码的 `protoMetadata`（ts-proto `outputServices=grpc-js,esModuleInterop=true,outputSchema=true,importSuffix=.js,enumsAsLiterals=true`）：重试和批量上限都从它来。
- **这里处理掉的 Node 行为**：HTTP 服务器 `close()` 时，关闭那一刻在途请求的连接会被保持，所以收尾期间持续关闭空闲连接；`request.signal` 在 POST 读完请求体后就会 abort，所以单元的取消只来自路由截止时间或客户端离开；`BeError` 用品牌符号识别而不是 `instanceof`，因为两份模块图之间的类不相同。

## 还没做（v0.6.0 的后续任务）

共享（`_shares/*` 在有 provider 的 `WriteTuples` 客户端之前答 501）、一致性令牌 `X-Authz-Revision`（P6.11）、图类型的 `ListObjects`；gRPC 的 `be.lifecycle.v1` 服务与冷层（P16 的 P1–P3）；日历、金额、编号、对象存储、缓存、快照（P11.6–P11.10、P15、P17）；PostgreSQL 总线适配器（P12.12）；测试包与外壳启动器（P19）。

## 开发

```sh
make sync-protocol      # 按钉住的 tag 把 be-protocol 的 schemas/、ddl/、proto/、vectors/（和 authz 判定向量）拷进 protocol/
make test               # 类型检查 + 单元测试：协议向量、纯逻辑、进程内服务器
make test-integration   # 一次性的 postgres:16、postgres:14、nats:2.12 容器（前缀 sdkb-ts-），跑完删除
make build              # dist/
```

`protocol/` 入库：运行时随包带 `protocol/schemas` 和 `protocol/ddl`，测试读 `protocol/vectors`；`protocol/PINNED` 记着提交号。`platform-migrations/` 由 `scripts/gen-platform-migration.mjs` 从 `protocol/ddl` 生成（`--check` 校验）。

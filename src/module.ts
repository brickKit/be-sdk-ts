/**
 * Module——对应 be-sdk-go 的 `Module`、be-sdk-python 的 `Module`。
 *
 * 模块交回去的一切。模块自己不 listen、不注册全局、不装信号处理器
 * （设计书 §12.5、§13.3 铁律七）。
 *
 * ⚠️ **没有 `registerGrpc` 字段**：`infra-bff-mobile` 只作为 gRPC
 * 客户端调别人，从不对外提供 gRPC（`registry/ports.tsv` 里它的 gRPC
 * 列是 `-`）。⚠️ **没有 `migrations` 字段**：TS 组件无数据库。
 */

import type { YogaServerInstance } from "graphql-yoga";

export interface Module {
  /** ⭐ 外壳对 Yoga/GraphQL 完全无感，它只 serve 一个 HTTP handler */
  httpHandler: YogaServerInstance<Record<string, unknown>, Record<string, unknown>>;
  /** 后台循环。收到 AbortSignal 时必须返回，不许自己装信号处理器 */
  start?: (signal: AbortSignal) => Promise<void>;
  stop?: () => Promise<void>;
}

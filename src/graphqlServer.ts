/**
 * newGraphQLServer——对应 be-sdk-go 的 `NewGinEngine`、be-sdk-python 的
 * `new_fastapi_app`。
 *
 * 发一个已挂好全部横切能力的 Yoga 实例：request-id、tracing、RED 指标、
 * 结构化访问日志、深度/复杂度限制、Persisted Operations，并已挂
 * `/healthz`。
 *
 * ⚠️ 组件不许自己 `createYoga()`——中间件漏一条不会报错，只是那个组件
 * 从此没有 trace、没有 RED 指标。
 *
 * ⚠️ `/healthz` 只检查本进程存活，不查依赖、不查数据库（设计书
 * §12.3.6）。Yoga 内置的 `healthCheckEndpoint` 选项直接给，不用自己
 * 拼一条 `onRequest` 短路。
 */

import { randomUUID } from "node:crypto";
import { createYoga, type Plugin, type YogaServerOptions } from "graphql-yoga";
import type { GraphQLSchema, DocumentNode } from "graphql";
import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import {
  usePersistedOperations,
  type UsePersistedOperationsOptions,
} from "@graphql-yoga/plugin-persisted-operations";
import { Counter, Histogram } from "@prometheus-io/client";
import type { Runtime } from "./runtime.js";

/**
 * §11.4.3 三条硬限制里，前两条（深度/复杂度）在这里写死默认值——
 * 不开放成参数，因为它们是平台级铁律不是每个组件的选择。第三条
 * （Persisted Operations）必须由调用方提供 `getPersistedOperation`，
 * 因为"构建期注册表长什么样"是每个组件自己的事。
 */
const MAX_DEPTH = 5;
const MAX_COST = 100;

export interface GraphQLServerOptions<TContext extends Record<string, unknown>>
  extends Pick<
    YogaServerOptions<Record<string, unknown>, TContext>,
    "schema" | "context"
  > {
  /** Persisted Operations 的查找函数——见 dataloader.ts 同款"调用方负责细节"的分工 */
  getPersistedOperation: UsePersistedOperationsOptions["getPersistedOperation"];
}

export function newGraphQLServer<TContext extends Record<string, unknown>>(
  rt: Runtime,
  options: GraphQLServerOptions<TContext>,
) {
  const reqTotal = new Counter({
    name: "graphql_requests_total",
    help: "GraphQL 请求总数（RED 的 Rate + Errors）",
    labelNames: ["status"],
    registers: [rt.registry],
  });
  const reqDuration = new Histogram({
    name: "graphql_request_duration_seconds",
    help: "GraphQL 请求耗时（RED 的 Duration）",
    registers: [rt.registry],
  });

  return createYoga<Record<string, unknown>, TContext>({
    schema: options.schema,
    context: options.context,
    healthCheckEndpoint: "/healthz",
    graphqlEndpoint: "/graphql",
    plugins: [
      EnvelopArmorPlugin({
        maxDepth: { enabled: true, n: MAX_DEPTH },
        costLimit: { enabled: true, maxCost: MAX_COST },
      }),
      usePersistedOperations({
        getPersistedOperation: options.getPersistedOperation,
        // ⭐ §11.4.3 的 persisted_queries_only: true——不允许任意查询，
        // 只认构建期注册表里已有的哈希。
        allowArbitraryOperations: false,
      }),
      {
        onRequest({ request }) {
          const requestId = request.headers.get("x-request-id") ?? randomUUID();
          (request as unknown as { beSdkRequestId: string }).beSdkRequestId = requestId;
        },
        onResponse({ request, response }) {
          const requestId = (request as unknown as { beSdkRequestId?: string })
            .beSdkRequestId;
          if (requestId) {
            response.headers.set("x-request-id", requestId);
          }
        },
      },
      {
        // ⚠️ tracing 用 rt.tracer——它已经由 bootstrap/initOtel 填好
        // （otelBaseUrl 为空时是 Blackhole Exporter），这里不重复判断
        // 有没有配置好，那是 initOtel 的职责边界（同 gin.go 的
        // tracingMiddleware 注释）。
        async onExecute({ args }: Parameters<NonNullable<Plugin["onExecute"]>>[0]) {
          const span = rt.tracer.startSpan(
            args.operationName ? `graphql ${args.operationName}` : "graphql",
          );
          const start = process.hrtime.bigint();
          return {
            onExecuteDone() {
              const elapsedNs = process.hrtime.bigint() - start;
              reqDuration.observe(Number(elapsedNs) / 1e9);
              span.end();
            },
          };
        },
        onResponse({ response }) {
          reqTotal.labels(String(response.status)).inc();
        },
      },
      {
        onResponse({ request, response }) {
          // ⚠️ 结构化日志、trace 上下文自动注入、PII 脱敏都在 logging.ts
          // 里，那里现在只有签名——这里先用 rt.logger 的基础接口占位，
          // logging.ts 补上真实实现后不用改这里的调用点。
          rt.logger.info(
            { method: request.method, url: request.url, status: response.status },
            "graphql request",
          );
        },
      },
    ],
  });
}

export type { GraphQLSchema, DocumentNode };

/**
 * OTel 初始化——对应 be-sdk-go 的 otel.go、be-sdk-python 的 otel.py。
 *
 * ⚠️ 用裸的 `TracerProvider`（`@opentelemetry/sdk-trace`），不用
 * `@opentelemetry/sdk-node` 的 `NodeSDK`——后者是"自动埋点"整套外壳
 * （`autoDetectResources`/`instrumentations` 等），我们只要 Go/Python
 * 两版一直用的那个最小心智模型："`otelBaseUrl` 为空 → 没有 span
 * processor 的裸 provider（Blackhole）；非空 → 挂一个
 * `BatchSpanProcessor(OTLPTraceExporter)`"，同 be-sdk-python 的
 * `otel.py` 逐字对应。
 */

import { trace, context, metrics, type Tracer, type Meter } from "@opentelemetry/api";
import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const BATCH_SCHEDULE_DELAY_MILLIS = 5000;

// ⚠️ 真机验证过的一处坑：只 setGlobalTracerProvider 不够——
// `@opentelemetry/api` 默认的 context manager 是彻头彻尾的 no-op
// （`context.with(ctx, fn)` 只是原样调 `fn()`，从不让 `ctx` 变成"当前
// 活跃"的那个），`trace.getActiveSpan()`（logging.ts 的 mixin 靠它拿
// trace_id/span_id）会永远拿到 undefined，即使 span 真的建出来了、
// `startActiveSpan` 的回调也真的跑了。`@opentelemetry/sdk-node` 的
// `NodeSDK` 会自动帮你注册一个；这里绕开 `NodeSDK` 用裸
// `TracerProvider`（見上方模块文档的理由），就必须自己补这一步——
// `AsyncLocalStorageContextManager`（比老的 `AsyncHooksContextManager`
// 更推荐）真机测试证实能让 `trace.getActiveSpan()` 在 `startActiveSpan`
// 的回调里正确拿到刚建的 span。`setGlobalContextManager` 本身是
// 幂等安全的（重复调用只警告，不抛异常），同一进程内多次 `initOtel`
// 不会出问题（阶段三 Task 11 的测试套件里真的这样调了好几次）。
let contextManagerRegistered = false;

/**
 * 初始化 OTel（`TracerProvider` + context manager），返回一个可以正常
 * 调用、不阻塞、不抛异常的 shutdown 函数。`otelBaseUrl` 为空时装
 * Blackhole——裸 `TracerProvider`，没有任何 span processor，`getTracer`
 * 拿到的 span 会被立刻丢弃，零导出成本（设计书 §7.5）。这是
 * `bootstrap` 唯一调用它的地方，模块自己永远不碰（§12.5.2）。
 */
export async function initOtel(
  serviceName: string,
  otelBaseUrl: string,
): Promise<() => Promise<void>> {
  if (!contextManagerRegistered) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    contextManagerRegistered = true;
  }

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

  const provider = otelBaseUrl
    ? new TracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({ url: otelBaseUrl }),
            scheduledDelayMillis: BATCH_SCHEDULE_DELAY_MILLIS,
          }),
        ],
      })
    : new TracerProvider({ resource });

  trace.setGlobalTracerProvider(provider);

  return async () => {
    await provider.shutdown();
  };
}

/** ⚠️ 必须在 `initOtel` 之后调用，否则拿到的是 `@opentelemetry/api` 自带的 no-op tracer。 */
export function getTracer(componentId: string): Tracer {
  return trace.getTracer(componentId);
}

/**
 * ⚠️ 本项目从未调用 `metrics.setGlobalMeterProvider`——指标走的是
 * `newRegistry()`（`@prometheus-io/client` 的 `Registry`）+ 手动
 * `Counter`/`Histogram`，不经过 OTel Metrics API。这里始终返回
 * `@opentelemetry/api` 内置的 no-op `Meter`，与 Go/Python 两版的既有
 * 行为一致（那两边的 `GetMeter`/`get_meter` 同样是文档化的永久 no-op）。
 */
export function getMeter(componentId: string): Meter {
  return metrics.getMeter(componentId);
}

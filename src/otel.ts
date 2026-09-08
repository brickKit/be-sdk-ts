/**
 * OTel 初始化——对应 be-sdk-go 的 otel.go、be-sdk-python 的 otel.py。
 * 目前只有签名，TDD 补实现。
 */

import type { Tracer, Meter } from "@opentelemetry/api";

/**
 * 初始化 OTel SDK（TracerProvider + MeterProvider）。
 *
 * ⚠️ `otelBaseUrl` 为空时装 Blackhole Exporter，不是报错、不是阻塞业务
 * 线程（设计书 §7.5：连不上必须静默丢弃）。这是 `bootstrap` 唯一调用它
 * 的地方——调用方（`runStandalone` 或外壳）恰好调一次，模块自己永远
 * 不碰（§12.5.2）。
 *
 * 实现随后用 TDD 补：最要紧的一条属性测试是"`otelBaseUrl` 为空时，
 * 返回的 shutdown 函数必须能正常调用且不抛异常、不阻塞"。
 */
export async function initOtel(
  _serviceName: string,
  _otelBaseUrl: string,
): Promise<() => Promise<void>> {
  throw new Error("阶段三 Task 2 后续 TDD 补");
}

export function getTracer(_componentId: string): Tracer {
  throw new Error("阶段三 Task 2 后续 TDD 补");
}

export function getMeter(_componentId: string): Meter {
  throw new Error("阶段三 Task 2 后续 TDD 补");
}

/**
 * initOtel/getTracer/getMeter——对应 be-sdk-go 的 otel_test.go、
 * be-sdk-python 的 test_otel.py，逐字对应。
 */

import { describe, expect, it } from "vitest";
import { getMeter, getTracer, initOtel } from "../src/otel.js";
import { isSpanContextValid } from "@opentelemetry/api";

describe("initOtel", () => {
  it("otelBaseUrl 为空时装 blackhole，shutdown 不阻塞不抛异常", async () => {
    const shutdown = await initOtel("test-service", "");
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("初始化之后 getTracer 拿到的不是 no-op tracer", async () => {
    const shutdown = await initOtel("test-service-tracer", "");
    try {
      const tracer = getTracer("test-service-tracer");
      await tracer.startActiveSpan("test-span", async (span) => {
        expect(isSpanContextValid(span.spanContext())).toBe(true);
        span.end();
      });
    } finally {
      await shutdown();
    }
  });

  it("真实 otlpEndpoint 时 provider 挂了导出器（不需要真的连上 collector）", async () => {
    const shutdown = await initOtel("test-service-otlp", "http://localhost:4318/v1/traces");
    try {
      const tracer = getTracer("test-service-otlp");
      await tracer.startActiveSpan("test-span", async (span) => {
        expect(isSpanContextValid(span.spanContext())).toBe(true);
        span.end();
      });
    } finally {
      // ⚠️ 即使 endpoint 连不上，shutdown 也不该抛异常卡住——批处理
      // 导出器的 flush 失败要被吞掉，不是这里断言的重点，但至少不能挂起。
      await expect(shutdown()).resolves.toBeUndefined();
    }
  });
});

describe("getMeter", () => {
  it("不需要 init 就能调，返回 no-op 也不报错", () => {
    const meter = getMeter("test-service-meter");
    const counter = meter.createCounter("test_counter");
    expect(() => counter.add(1)).not.toThrow();
  });
});

/**
 * newLogger——对应 be-sdk-go 的 logging_test.go、be-sdk-python 的
 * test_logging.py，逐字对应。
 */

import { describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { buildLogger } from "../src/logging.js";
import { initOtel } from "../src/otel.js";

class CollectingDestination implements DestinationStream {
  lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  lastEntry(): Record<string, unknown> {
    const line = this.lines.at(-1);
    if (!line) throw new Error("没有任何一行日志");
    return JSON.parse(line.trimEnd()) as Record<string, unknown>;
  }
}

describe("buildLogger", () => {
  it("输出是合法 JSON，且带 component_id", () => {
    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    logger.info("hello world");

    const entry = dest.lastEntry();
    expect(entry.component_id).toBe("test-component");
    expect(entry.msg).toBe("hello world");
    expect(entry.level).toBe("info");
  });

  it("额外字段被合并进 JSON 而不是丢失", () => {
    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    logger.info({ order_id: "SO-123" }, "with extra");

    const entry = dest.lastEntry();
    expect(entry.order_id).toBe("SO-123");
  });

  it("有 span 时自动带 trace_id/span_id", async () => {
    // ⚠️ 真实踩过的坑：只建一个裸 TracerProvider 是不够的——
    // `@opentelemetry/api` 默认的 context manager 是彻头彻尾的
    // no-op（`context.with` 不会真的让 ctx"活跃"），`getActiveSpan`
    // 永远拿 undefined，即使 span 真的建出来了。Python 版不用这一步
    // （contextvars 天生就是"活跃"的），这是这次移植中发现的一处真实
    // JS/Python OTel SDK 行为差异，不是这条测试自己多此一举——
    // 必须先跑一次 initOtel（同生产环境 bootstrap 的真实调用顺序：
    // initOtel 总是先于 newLogger 被用到）来注册 context manager。
    await initOtel("test-logging-span", "");

    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    const provider = new TracerProvider();
    const tracer = provider.getTracer("test-tracer");

    tracer.startActiveSpan("test-span", (span) => {
      logger.info("inside span");
      span.end();
    });

    const entry = dest.lastEntry();
    expect(entry.trace_id).toBeTypeOf("string");
    expect(entry.span_id).toBeTypeOf("string");
    expect((entry.trace_id as string).length).toBe(32); // 128-bit trace id 的十六进制表示
    expect((entry.span_id as string).length).toBe(16); // 64-bit span id 的十六进制表示
  });

  it("没有 span 时不带 trace_id 字段", () => {
    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    logger.info("no span here");

    const entry = dest.lastEntry();
    expect(entry.trace_id).toBeUndefined();
  });

  it("已知敏感字段被脱敏", () => {
    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    logger.info({ phone: "13800000000", safe_field: "not secret" }, "联系方式");

    const entry = dest.lastEntry();
    expect(entry.phone).toBe("[REDACTED]");
    expect(entry.safe_field).toBe("not secret");
  });

  it("超过 2KB 的内容被截断", () => {
    const dest = new CollectingDestination();
    const logger = buildLogger(dest, "test-component");
    logger.info({ payload: "x".repeat(5000) }, "big payload");

    const line = dest.lines.at(-1)!.trimEnd();
    expect(line.length).toBeLessThanOrEqual(2048);
    expect(line.endsWith("...[TRUNCATED]")).toBe(true);
  });

  it("两次 buildLogger 同名不会互相污染输出（pino 无全局按名字单例，天然独立）", () => {
    const dest1 = new CollectingDestination();
    const dest2 = new CollectingDestination();
    const logger1 = buildLogger(dest1, "same-name");
    const logger2 = buildLogger(dest2, "same-name");

    logger1.info("only in dest1");
    logger2.info("only in dest2");

    expect(dest1.lines.join("")).toContain("only in dest1");
    expect(dest1.lines.join("")).not.toContain("only in dest2");
    expect(dest2.lines.join("")).toContain("only in dest2");
    expect(dest2.lines.join("")).not.toContain("only in dest1");
  });
});

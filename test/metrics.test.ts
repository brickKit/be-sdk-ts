/**
 * newRegistry——对应 be-sdk-go 的 metrics_test.go、be-sdk-python 的
 * test_metrics.py。
 */

import { describe, expect, it } from "vitest";
import { Counter } from "@prometheus-io/client";
import { newRegistry } from "../src/metrics.js";

describe("newRegistry", () => {
  it("每次调用返回独立的 registry，不是默认全局的那个", () => {
    const r1 = newRegistry();
    const r2 = newRegistry();
    expect(r1).not.toBe(r2);

    // 同名指标注册到两个独立 registry 不该互相冲突（若共用默认全局
    // registry，第二次 new Counter 会直接抛 "metric already registered"）。
    expect(
      () =>
        new Counter({ name: "be_sdk_ts_test_counter", help: "test", registers: [r1] }),
    ).not.toThrow();
    expect(
      () =>
        new Counter({ name: "be_sdk_ts_test_counter", help: "test", registers: [r2] }),
    ).not.toThrow();
  });
});

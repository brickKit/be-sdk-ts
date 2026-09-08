/**
 * Config 的 camelCase 查询——阶段三计划 Task 1/2 明确要求的回归测试，
 * 与 be-sdk-go/be-sdk-python 的同名测试逐字对应。
 */

import { describe, expect, it } from "vitest";
import { Config, configEnvVarName } from "../src/config.js";

describe("configEnvVarName", () => {
  it("camelCase 查询能找到平台真实注入的环境变量", () => {
    const cfg = new Config({ PG_SCHEMA: "erp_sales" });
    const { value, ok } = cfg.string("pgSchema");
    expect(ok).toBe(true);
    expect(value).toBe("erp_sales");
  });

  it("转换算法与 Go/Python 版逐字对应", () => {
    const cases: Record<string, string> = {
      pgSchema: "PG_SCHEMA",
      otelBaseUrl: "OTEL_BASE_URL",
      defaultWarehouseId: "DEFAULT_WAREHOUSE_ID",
      enabledComponents: "ENABLED_COMPONENTS",
      iamJwksUrl: "IAM_JWKS_URL",
    };
    for (const [key, want] of Object.entries(cases)) {
      expect(configEnvVarName(key)).toBe(want);
    }
  });

  it("已经是 SCREAMING_SNAKE_CASE 的输入是幂等的", () => {
    expect(configEnvVarName("PG_SCHEMA")).toBe("PG_SCHEMA");
    expect(configEnvVarName("DEFAULT_WAREHOUSE_ID")).toBe("DEFAULT_WAREHOUSE_ID");
  });
});

describe("Config", () => {
  it("mustString 拿不到必填项直接抛异常", () => {
    const cfg = new Config({});
    expect(() => cfg.mustString("defaultWarehouseId")).toThrow(/defaultWarehouseId/);
  });

  it("stringOr 查不到用 default", () => {
    const cfg = new Config({});
    expect(cfg.stringOr("otelBaseUrl", "")).toBe("");
    expect(cfg.stringOr("otelBaseUrl", "http://otel:4318")).toBe("http://otel:4318");
  });

  it("intOr 与 boolOr 的类型转换，转换失败时用 default 不抛异常", () => {
    const cfg = new Config({ RETRY_MAX: "3", FEATURE_ENABLED: "true" });
    expect(cfg.intOr("retryMax", 0)).toBe(3);
    expect(cfg.boolOr("featureEnabled", false)).toBe(true);

    const bad = new Config({ RETRY_MAX: "not-a-number" });
    expect(bad.intOr("retryMax", 5)).toBe(5);
  });

  it("两个 Config 各持一份互不干扰", () => {
    const c1 = new Config({ PG_SCHEMA: "erp_sales" });
    const c2 = new Config({ PG_SCHEMA: "erp_inventory" });
    expect(c1.stringOr("pgSchema", "")).toBe("erp_sales");
    expect(c2.stringOr("pgSchema", "")).toBe("erp_inventory");
  });
});

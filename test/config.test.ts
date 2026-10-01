/**
 * Config v1：精确键名匹配（不做驼峰转换）、依赖地址只从 Config 读（绝不回落 process.env）、S3_URL。
 */

import { describe, expect, it } from "vitest";
import { Config } from "../src/config.js";

describe("Config v1", () => {
  it("精确匹配键名，不做驼峰转换", () => {
    const c = new Config({ PG_SCHEMA: "x" });
    expect(c.string("PG_SCHEMA")).toEqual({ value: "x", ok: true });
    expect(c.string("pgSchema")).toEqual({ value: "", ok: false });
  });

  it("endpoint 剥掉 scheme 与结尾斜杠", () => {
    const c = new Config({ ERP_SALES_ENDPOINT: "http://be-go-core-1-0-0:8084/" });
    expect(c.endpoint("erp/sales")).toEqual({ value: "be-go-core-1-0-0:8084", ok: true });
  });

  it("endpoint 不看 process.env", () => {
    process.env.ERP_SALES_ENDPOINT = "http://wrong:1";
    try {
      expect(new Config({}).endpoint("erp/sales")).toEqual({ value: "", ok: false });
    } finally {
      delete process.env.ERP_SALES_ENDPOINT;
    }
  });

  it("键缺失与值为空都视为缺失", () => {
    expect(new Config({}).endpoint("infra/workflow")).toEqual({ value: "", ok: false });
    expect(new Config({ INFRA_WORKFLOW_ENDPOINT: "" }).endpoint("infra/workflow")).toEqual({
      value: "",
      ok: false,
    });
  });

  it("额外端口：INTEGRATION_IM_DINGTALK_GRPC_ENDPOINT", () => {
    const c = new Config({ INTEGRATION_IM_DINGTALK_GRPC_ENDPOINT: "http://dingtalk:9090" });
    expect(c.endpoint("integration/im-dingtalk", "grpc")).toEqual({ value: "dingtalk:9090", ok: true });
  });

  it("mustEndpoint 报错信息带变量名", () => {
    expect(() => new Config({}).mustEndpoint("erp/inventory", "grpc")).toThrow(/ERP_INVENTORY_GRPC_ENDPOINT/);
  });

  it("s3Url", () => {
    expect(new Config({ S3_URL: "http://rustfs:9000" }).s3Url()).toEqual({ value: "http://rustfs:9000", ok: true });
    expect(new Config({}).s3Url()).toEqual({ value: "", ok: false });
  });

  it("mustString 拿不到必填项直接抛异常", () => {
    expect(() => new Config({}).mustString("DEFAULT_WAREHOUSE_ID")).toThrow(/DEFAULT_WAREHOUSE_ID/);
  });

  it("stringOr 查不到用 default", () => {
    const cfg = new Config({});
    expect(cfg.stringOr("OTEL_BASE_URL", "")).toBe("");
    expect(cfg.stringOr("OTEL_BASE_URL", "http://otel:4318")).toBe("http://otel:4318");
  });

  it("intOr 与 boolOr 的类型转换，转换失败时用 default 不抛异常", () => {
    const cfg = new Config({ RETRY_MAX: "3", FEATURE_ENABLED: "true" });
    expect(cfg.intOr("RETRY_MAX", 0)).toBe(3);
    expect(cfg.boolOr("FEATURE_ENABLED", false)).toBe(true);
    expect(new Config({ RETRY_MAX: "not-a-number" }).intOr("RETRY_MAX", 5)).toBe(5);
  });

  it("两个 Config 各持一份互不干扰", () => {
    const c1 = new Config({ PG_SCHEMA: "erp_sales" });
    const c2 = new Config({ PG_SCHEMA: "erp_inventory" });
    expect(c1.stringOr("PG_SCHEMA", "")).toBe("erp_sales");
    expect(c2.stringOr("PG_SCHEMA", "")).toBe("erp_inventory");
  });
});

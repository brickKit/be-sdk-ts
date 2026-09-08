/**
 * endpoint() 剥 scheme + 二值返回——对应 be-sdk-go 的 endpoint_test.go、
 * be-sdk-python 的 test_endpoint.py。
 */

import { afterEach, describe, expect, it } from "vitest";
import { endpoint, mustEndpoint, storageEndpoint } from "../src/endpoint.js";

afterEach(() => {
  delete process.env.MDM_CUSTOMER_ENDPOINT;
  delete process.env.INTEGRATION_IM_DINGTALK_GRPC_ENDPOINT;
  delete process.env.INFRA_WORKFLOW_ENDPOINT;
  delete process.env.MDM_PRODUCT_ENDPOINT;
  delete process.env.STORAGE_ENDPOINT;
});

describe("endpoint", () => {
  it("剥掉 http 前缀", () => {
    process.env.MDM_CUSTOMER_ENDPOINT = "http://mdm-customer-1-0-1:8080";
    const { value, ok } = endpoint("mdm/customer");
    expect(ok).toBe(true);
    expect(value).toBe("mdm-customer-1-0-1:8080");
  });

  it("额外端口的变量名带 extra", () => {
    process.env.INTEGRATION_IM_DINGTALK_GRPC_ENDPOINT =
      "http://integration-im-dingtalk-1-0-0:9207";
    const { value, ok } = endpoint("integration/im-dingtalk", "grpc");
    expect(ok).toBe(true);
    expect(value).toBe("integration-im-dingtalk-1-0-0:9207");
  });

  it("弱依赖缺失时键根本不存在，不是空串", () => {
    const { value, ok } = endpoint("infra/workflow");
    expect(ok).toBe(false);
    expect(value).toBe("");
  });

  it("mustEndpoint 缺失时抛异常", () => {
    expect(() => mustEndpoint("mdm/product")).toThrow(/mdm\/product/);
  });

  it("storageEndpoint 方向相反：加 scheme 而不是剥", () => {
    // ⚠️ STORAGE_ENDPOINT 是唯一一个名字带 ENDPOINT、值却是裸 host:port
    // 的变量（导读第 12 条）——这条测试锁死方向不会被改反。
    process.env.STORAGE_ENDPOINT = "rustfs:9000";
    expect(storageEndpoint(false)).toEqual({ value: "http://rustfs:9000", ok: true });
    expect(storageEndpoint(true)).toEqual({ value: "https://rustfs:9000", ok: true });
  });
});

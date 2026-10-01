/**
 * envName 推导平台注入的变量名——规则必须与平台 manifest.EnvPrefix 一致。
 */

import { describe, expect, it } from "vitest";
import { envName } from "../src/endpoint.js";

describe("envName", () => {
  it("斜杠与连字符换成下划线并全大写", () => {
    expect(envName("mdm/customer")).toBe("MDM_CUSTOMER_ENDPOINT");
    expect(envName("integration/im-dingtalk", "grpc")).toBe("INTEGRATION_IM_DINGTALK_GRPC_ENDPOINT");
    expect(envName("erp/inventory", "grpc")).toBe("ERP_INVENTORY_GRPC_ENDPOINT");
  });
});

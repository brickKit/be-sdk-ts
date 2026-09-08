/**
 * 真机对接 infra-authz——对应 be-sdk-go 的 bundle_integration_test.go、
 * be-sdk-python 的 tests/test_bundle_integration.py。
 *
 * 不是 mock：直接打真实跑着的 infra-authz 容器的 GET /authz/bundle，
 * 确认 be-sdk-ts 的轮询客户端认得它实际吐出来的 JSON 形状（三份 SDK
 * 是本项目自己分三次写的，最容易出现"字段名各写各的"这类耦合裂缝）。
 * 设了 TEST_AUTHZ_BUNDLE_URL 才跑，同 TEST_PG_DSN 的约定。
 */

import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { BundleCache } from "../src/bundle.js";

function fakeLogger(): Logger {
  return { warn: () => {}, error: () => {}, info: () => {} } as unknown as Logger;
}

const url = process.env["TEST_AUTHZ_BUNDLE_URL"] ?? "";

describe.skipIf(url === "")("真机对接 infra-authz", () => {
  it("认得出真实的自举种子数据（authz_admin/infra.authz.admin）", async () => {
    const cache = new BundleCache();

    await cache.fetchOnce(url, fakeLogger());

    // infra-authz 的迁移种了 authz_admin/infra.authz.admin 这条真实的
    // 自举数据（003_seed_bootstrap_admin_role.up.sql）——用它做断言，
    // 不用测试自己造的数据，这样即使全新环境第一次跑也能通过。
    expect(cache.hasEverFetched()).toBe(true);
    expect(cache.hasPermission(["authz_admin"], "infra.authz.admin")).toBe(true);
  });
});

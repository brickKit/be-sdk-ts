import { describe, expect, it } from "vitest";
import { batchCheck } from "../../../src/grpc/batchLimits.js";
import { methodsOf, serviceConfig } from "../../../src/grpc/descriptors.js";
import { protoMetadata } from "../../gen/sdktest/v1/echo.js";

const n = (k: number) => Array.from({ length: k }, (_, i) => `x${i}`);

describe("service config from protoMetadata (P7.8)", () => {
  it("retries NO_SIDE_EFFECTS and IDEMPOTENT methods only, with the protocol's policy and budget", () => {
    const sc = serviceConfig([protoMetadata]);
    expect(sc.retryThrottling).toEqual({ maxTokens: 10, tokenRatio: 0.1 });
    expect(sc.methodConfig).toHaveLength(1);
    expect(sc.methodConfig[0]!.retryPolicy).toEqual({
      maxAttempts: 3, initialBackoff: "0.05s", maxBackoff: "0.5s", backoffMultiplier: 2, retryableStatusCodes: ["UNAVAILABLE"],
    });
    const names = sc.methodConfig[0]!.name.map((x) => `${x.service}/${x.method}`);
    expect(names).toEqual(["sdktest.echo.v1.EchoService/Approve", "sdktest.echo.v1.EchoService/BatchGet", "sdktest.echo.v1.EchoService/Get",
      "sdktest.echo.v1.EchoService/Slow", "sdktest.echo.v1.EchoService/Touch"]);
    expect(names).not.toContain("sdktest.echo.v1.EchoService/Create");
  });

  it("lists methods by grpc-js path, streaming ones marked", () => {
    const m = methodsOf(protoMetadata);
    expect(m.get("/sdktest.echo.v1.EchoService/Get")).toMatchObject({ service: "sdktest.echo.v1.EchoService", method: "Get", inputType: ".sdktest.echo.v1.GetRequest", idempotencyLevel: 1, streaming: false });
    expect(m.get("/sdktest.echo.v1.WatchService/Watch")?.streaming).toBe(true);
  });
});

describe("batch limits (P7.10)", () => {
  const check = batchCheck(protoMetadata, ".sdktest.echo.v1.BatchGetRequest");
  it("explicit limit", () => {
    expect(check({ ids: n(3) })).toBeUndefined();
    expect(check({ ids: n(4) })).toEqual({ field: "ids", max: 3, got: 4 });
  });
  it("default 500 without the option", () => {
    expect(check({ tags: n(500) })).toBeUndefined();
    expect(check({ tags: n(501) })).toEqual({ field: "tags", max: 500, got: 501 });
  });
  it("nested message (snake_case field, camelCase property)", () => {
    expect(check({ filter: { skuIds: n(2) } })).toBeUndefined();
    expect(check({ filter: { skuIds: n(3) } })).toEqual({ field: "filter.sku_ids", max: 2, got: 3 });
  });
  it("inside the elements of a repeated message field, and on that field itself", () => {
    expect(check({ items: [{ codes: n(2) }, { codes: n(3) }] })).toEqual({ field: "items[1].codes", max: 2, got: 3 });
    expect(check({ items: Array.from({ length: 11 }, () => ({ codes: [] })) })).toEqual({ field: "items", max: 10, got: 11 });
  });
  it("ignores map fields and absent values", () => {
    expect(check({ labels: Object.fromEntries(n(600).map((k) => [k, k])) })).toBeUndefined();
    expect(check({})).toBeUndefined();
    expect(check(undefined)).toBeUndefined();
  });
});

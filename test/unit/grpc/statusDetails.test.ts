import { describe, expect, it } from "vitest";
import { decodeStatus, encodeStatus, type StatusDetails } from "../../../src/grpc/statusDetails.js";
import { Any } from "../../gen/google/protobuf/any.js";
import { BadRequest, ErrorInfo, PreconditionFailure, ResourceInfo, RetryInfo } from "../../gen/google/rpc/error_details.js";
import { Status } from "../../gen/google/rpc/status.js";

const full: StatusDetails = {
  code: 3,
  message: "Too many ids: 501 > 500",
  errorInfo: { reason: "BATCH_TOO_LARGE", domain: "be", metadata: { field: "ids", max: "500", got: "501", "名": "值" } },
  badRequest: [{ field: "ids", description: "at most 500 items", reason: "BATCH_TOO_LARGE" }],
  retryDelayMs: 1500,
  preconditionFailure: [{ type: "STOCK", subject: "sku/1", description: "none left" }],
  resourceInfo: { resourceType: "widget", resourceName: "w1", owner: "erp/x", description: "d" },
};

describe("google.rpc.Status codec (P4.2)", () => {
  it("round-trips every detail it knows", () => {
    expect(decodeStatus(encodeStatus(full))).toEqual({ ...full, unknown: [] });
  });

  it("round-trips the minimum: ErrorInfo with empty metadata", () => {
    const s: StatusDetails = { code: 13, message: "", errorInfo: { reason: "INTERNAL", domain: "be", metadata: {} } };
    expect(decodeStatus(encodeStatus(s))).toEqual({ ...s, unknown: [] });
  });

  it("is read by a generated google.rpc decoder (interop with the upstream field numbers)", () => {
    const st = Status.decode(encodeStatus(full));
    expect(st.code).toBe(3);
    expect(st.message).toBe(full.message);
    expect(st.details.map((d) => d.typeUrl)).toEqual([
      "type.googleapis.com/google.rpc.ErrorInfo",
      "type.googleapis.com/google.rpc.BadRequest",
      "type.googleapis.com/google.rpc.RetryInfo",
      "type.googleapis.com/google.rpc.PreconditionFailure",
      "type.googleapis.com/google.rpc.ResourceInfo",
    ]);
    expect(ErrorInfo.decode(st.details[0]!.value)).toEqual(full.errorInfo);
    expect(BadRequest.decode(st.details[1]!.value).fieldViolations).toEqual(full.badRequest);
    expect(RetryInfo.decode(st.details[2]!.value).retryDelay).toEqual({ seconds: 1, nanos: 500_000_000 });
    expect(PreconditionFailure.decode(st.details[3]!.value).violations).toEqual(full.preconditionFailure);
    expect(ResourceInfo.decode(st.details[4]!.value)).toEqual(full.resourceInfo);
  });

  it("reads what a generated encoder wrote, keeping unknown details aside", () => {
    const bytes = Status.encode({
      code: 9,
      message: "Only 2 left",
      details: [
        Any.fromPartial({ typeUrl: "type.googleapis.com/google.rpc.ErrorInfo", value: ErrorInfo.encode({ reason: "INSUFFICIENT_STOCK", domain: "erp/inventory", metadata: { available: "2" } }).finish() }),
        Any.fromPartial({ typeUrl: "type.googleapis.com/google.rpc.RetryInfo", value: RetryInfo.encode({ retryDelay: { seconds: 0, nanos: 250_000_000 } }).finish() }),
        Any.fromPartial({ typeUrl: "type.googleapis.com/google.rpc.DebugInfo", value: new Uint8Array([10, 1, 120]) }),
      ],
    }).finish();
    const d = decodeStatus(bytes);
    expect(d).toMatchObject({ code: 9, message: "Only 2 left", errorInfo: { reason: "INSUFFICIENT_STOCK", domain: "erp/inventory", metadata: { available: "2" } }, retryDelayMs: 250 });
    expect(d.unknown).toEqual([{ typeUrl: "type.googleapis.com/google.rpc.DebugInfo", value: new Uint8Array([10, 1, 120]) }]);
  });

  it("matches a fixed byte vector derived by hand from status.proto / error_details.proto", () => {
    // Status{code:16, message:"x", details:[Any{type_url:"type.googleapis.com/google.rpc.ErrorInfo",
    //   value: ErrorInfo{reason:"R", domain:"be"}}]}
    const url = Array.from(new TextEncoder().encode("type.googleapis.com/google.rpc.ErrorInfo"));
    const info = [0x0a, 1, 0x52, 0x12, 2, 0x62, 0x65];
    const any = [0x0a, url.length, ...url, 0x12, info.length, ...info];
    const expected = new Uint8Array([0x08, 16, 0x12, 1, 0x78, 0x1a, any.length, ...any]);
    expect(encodeStatus({ code: 16, message: "x", errorInfo: { reason: "R", domain: "be", metadata: {} } })).toEqual(expected);
  });

  it("refuses truncated input", () => {
    const b = encodeStatus(full);
    expect(() => decodeStatus(b.subarray(0, b.length - 3))).toThrow();
  });
});

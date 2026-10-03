// P7.7 / P3.4: once the outbound budget has ended the call failed because of the budget, whatever status gRPC
// reports at that moment. A stream reset at the budget's end comes back as CANCELLED, INTERNAL or UNAVAILABLE
// instead of DEADLINE_EXCEEDED; the caller must still answer 504.
import { Metadata, status as GrpcStatus, type InterceptorOptions, type StatusObject } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { platformError } from "../../../src/errors/beError.js";
import { deadlineInterceptor } from "../../../src/grpc/clientInterceptors.js";
import { fromStatus, localStatus } from "../../../src/grpc/errors.js";

type Listener = { onReceiveStatus(s: StatusObject): void };

/** Runs one call through the deadline interceptor; the transport answers `answer` at `when`. */
function call(budgetMs: number, when: "at-deadline" | "early", answer: StatusObject): Promise<StatusObject> {
  const options = { method_definition: { path: "/conformance.peer.v1.PeerService/BatchGet" }, deadline: Date.now() + budgetMs } as unknown as InterceptorOptions;
  return new Promise((resolve) => {
    const transport = (o: InterceptorOptions) => ({
      start(_md: Metadata, listener: Listener) {
        const wait = when === "early" ? 1 : (o.deadline as number) - Date.now();
        setTimeout(() => listener.onReceiveStatus(answer), wait);
      },
    });
    deadlineInterceptor(options, transport as never).start(new Metadata(), { onReceiveStatus: resolve });
  });
}

const reset = (code: GrpcStatus): StatusObject => ({ code, details: "stream terminated", metadata: new Metadata() });

describe("the budget's end (P7.7)", () => {
  it.each([
    ["CANCELLED", reset(GrpcStatus.CANCELLED)],
    ["INTERNAL", reset(GrpcStatus.INTERNAL)],
    ["UNKNOWN", reset(GrpcStatus.UNKNOWN)],
    ["DEADLINE_EXCEEDED", reset(GrpcStatus.DEADLINE_EXCEEDED)],
    ["UNAVAILABLE as the runtime renders it", localStatus(platformError("DEPENDENCY_UNAVAILABLE", { dependency: "conformance/peer" }, "cannot be reached"))],
  ])("is the deadline whatever gRPC reports: %s", async (_name, answer) => {
    const e = fromStatus(await call(80, "at-deadline", answer))!;
    expect([e.code, e.domain, e.reason]).toEqual(["DEADLINE_EXCEEDED", "be", "DEADLINE_BUDGET_EXHAUSTED"]);
  });

  it("an error before the budget ends is kept", async () => {
    const e = fromStatus(await call(1_000, "early", reset(GrpcStatus.INTERNAL)))!;
    expect([e.code, e.reason]).toEqual(["INTERNAL", ""]);
  });

  it("a success at the budget's end stays a success", async () => {
    expect((await call(80, "at-deadline", { code: GrpcStatus.OK, details: "", metadata: new Metadata() })).code).toBe(GrpcStatus.OK);
  });
});

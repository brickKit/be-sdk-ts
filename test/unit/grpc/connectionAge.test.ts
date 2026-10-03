import { describe, expect, it } from "vitest";
import { unary } from "../../../src/grpc/clients.js";
import { CreateRequest, EchoServiceClient, GetRequest, protoMetadata } from "../../gen/sdktest/v1/echo.js";
import { echoHarness, SERVER_ID } from "../../support/grpcEcho.js";

describe("MaxConnectionAge (P7.5, CP-RPC-05)", () => {
  it("GOAWAY after the age rotates connections; calls keep succeeding, non-retryable ones included", async () => {
    const h = await echoHarness({ maxConnectionAgeMs: 500 }); // grace stays 30 s
    try {
      const c = h.clients().clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
      const end = Date.now() + 2_000;
      const outcomes = new Map<string, number>();
      let i = 0;
      const loop = async (create: boolean) => {
        while (Date.now() < end) {
          const id = `age${i++}`;
          const p = create ? unary(c.create.bind(c), CreateRequest.fromPartial({ id })) : unary(c.get.bind(c), GetRequest.fromPartial({ id }));
          const k = await p.then(() => "ok", (e) => `${e.code}/${e.reason}`);
          outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
        }
      };
      await Promise.all(Array.from({ length: 4 }, (_, w) => loop(w % 2 === 1)));
      expect([...outcomes.keys()]).toEqual(["ok"]);
      expect(outcomes.get("ok")).toBeGreaterThan(50);
      expect(h.peers.size).toBeGreaterThanOrEqual(2); // the server really rotated the connection
    } finally {
      await h.close();
    }
  });
});

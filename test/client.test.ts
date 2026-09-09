/**
 * userClient/systemClient——对应 be-sdk-go 的 client_test.go。
 *
 * ⚠️ 这个文件在此前是全空的：`userClient` 内部试图把 CallCredentials
 * 组合进 insecure ChannelCredentials，真机第一次被 `infra-bff-mobile`
 * 调用时才炸出 `Cannot compose insecure credentials`（`@grpc/grpc-js`
 * 的既有设计：调用凭据不允许绑在未加密通道上，见 client.ts 模块文档）
 * ——这里补上回归测试：真起一个手写的 gRPC echo 服务（不需要 .proto，
 * `grpc.Server.addService` 接受裸 `ServiceDefinition`），真连、真发
 * 请求，断言服务端真的收到了转发的 Authorization。
 */

import { describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { userClient, systemClient } from "../src/client.js";

function encode(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}
function decode(buf: Buffer): unknown {
  return JSON.parse(buf.toString());
}

// 手写一个最小的 unary echo 服务：请求体原样回传，另外把服务端看到的
// metadata 里的 authorization 值也带回去——不需要为一条测试专门写
// .proto，序列化用 JSON 顶替 protobuf（内容不重要，只是要一对能用的
// serialize/deserialize，同 be-sdk-go client_test.go 的既有判据：
// 借一个手搭的服务比为测试写 .proto 更直接）。
const echoServiceDefinition: grpc.ServiceDefinition = {
  echo: {
    path: "/besdktest.Echo/Echo",
    requestStream: false,
    responseStream: false,
    requestSerialize: encode,
    requestDeserialize: decode,
    responseSerialize: encode,
    responseDeserialize: decode,
  },
};

async function startEchoServer(): Promise<{ port: number; server: grpc.Server }> {
  const server = new grpc.Server();
  server.addService(echoServiceDefinition, {
    echo: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const auth = call.metadata.get("authorization")[0] ?? null;
      callback(null, { received: call.request, authorization: auth });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });
  return { port, server };
}

function callEcho(target: string, credentials: grpc.ChannelCredentials, options: grpc.ClientOptions, payload: unknown) {
  const EchoClientCtor = grpc.makeGenericClientConstructor(echoServiceDefinition, "Echo");
  const client = new EchoClientCtor(target, credentials, options);
  return new Promise((resolve, reject) => {
    (client as unknown as { echo: Function }).echo(payload, (err: grpc.ServiceError | null, res: unknown) => {
      client.close();
      if (err) reject(err);
      else resolve(res);
    });
  });
}

describe("userClient", () => {
  it("真实连上一个 insecure gRPC 服务，且把 Authorization 转发到服务端（不再抛 Cannot compose insecure credentials）", async () => {
    const { port, server } = await startEchoServer();
    process.env.BESDKTEST_ECHO_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
      const { target, credentials, options } = userClient("Bearer test-token-123", "besdktest/echo");
      const res = (await callEcho(target, credentials, options, { hello: "world" })) as {
        received: { hello: string };
        authorization: string | null;
      };
      expect(res.received).toEqual({ hello: "world" });
      expect(res.authorization).toBe("Bearer test-token-123");
    } finally {
      delete process.env.BESDKTEST_ECHO_ENDPOINT;
      server.forceShutdown();
    }
  });

  it("auth 为空字符串时不设置 authorization metadata（不是设成空字符串）", async () => {
    const { port, server } = await startEchoServer();
    process.env.BESDKTEST_ECHO_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
      const { target, credentials, options } = userClient("", "besdktest/echo");
      const res = (await callEcho(target, credentials, options, {})) as { authorization: string | null };
      expect(res.authorization).toBeNull();
    } finally {
      delete process.env.BESDKTEST_ECHO_ENDPOINT;
      server.forceShutdown();
    }
  });
});

describe("systemClient", () => {
  it("不转发任何身份——即使调用方传了 auth 也不带（systemClient 根本不接受 auth 参数）", async () => {
    const { port, server } = await startEchoServer();
    process.env.BESDKTEST_ECHO_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
      const { target, credentials, options } = systemClient("besdktest/echo");
      const res = (await callEcho(target, credentials, options, {})) as { authorization: string | null };
      expect(res.authorization).toBeNull();
    } finally {
      delete process.env.BESDKTEST_ECHO_ENDPOINT;
      server.forceShutdown();
    }
  });
});

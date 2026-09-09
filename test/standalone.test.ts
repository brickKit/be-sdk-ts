/**
 * runStandalone——对应 be-sdk-go 的 standalone_test.go
 * `TestRunStandalone_healthz真的能响应不panic`：真走一遍子进程
 * （`bootstrap` → `newLogger`/`newRegistry`/`getTracer` →
 * `newGraphQLServer` → 真实 HTTP 监听），不是在测试进程里直接调
 * `runStandalone` 内部函数——那样测不出"Runtime 组装出来的东西传给
 * `newGraphQLServer` 会不会直接崩"这类问题（同 be-sdk-go A4g 的教训：
 * 单元测试的构造路径和生产构造路径不是同一条时，前者测不出后者的坑；
 * 这次移植过程中真的靠这个思路在 otel.ts 上抓到一个真实 bug，context
 * manager 没注册——标准库层面的 `newLogger`/`newGraphQLServer` 单测都
 * 测不出来，因为它们各自都不会自己调 `initOtel`）。
 *
 * ⚠️ `infra-bff-mobile`（本仓库唯一的消费者）零 DB、零 NATS
 * 依赖——不需要像 Go 版那样另外伪造 DATABASE_ 前缀/MQ_ 前缀环境变量，
 * `runStandalone`/`Runtime` 本来就没有这两个字段。
 */

import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/standaloneHealthzModule.ts", import.meta.url));
const TSX_BIN = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("拿不到监听端口")));
      }
    });
  });
}

async function waitForListen(port: number, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`端口 ${port} 在 ${deadlineMs}ms 内没有开始监听`);
}

describe("runStandalone", () => {
  it(
    "真实子进程：/healthz 能响应 200，不 panic、不连接被拒绝",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "besdk-ts-standalone-"));
      const port = await freePort();
      await writeFile(join(dir, "component.yaml"), `deployment:\n  port: ${port}\n`);

      let child: ChildProcess | undefined;
      let stderr = "";
      try {
        child = spawn(TSX_BIN, [FIXTURE], {
          cwd: dir,
          env: {
            ...process.env,
            COMPONENT_ID: "test/healthz-module",
            COMPONENT_VERSION: "0.0.1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        await waitForListen(port);

        const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(resp.status, `stderr:\n${stderr}`).toBe(200);
      } finally {
        child?.kill("SIGTERM");
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

/**
 * bootstrap / runStandalone——对应 be-sdk-go 的 standalone.go、
 * be-sdk-python 的 standalone.py。
 *
 * ⚠️ 比 Go/Python 版明显薄：没有起数据库连接池、没有连 NATS——
 * `infra-bff-mobile` 两者都不需要（runtime.ts 已经说明）。也没有
 * "额外端口"这件事：本组件不对外提供 gRPC，只作为客户端调别人。
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { Module } from "./module.js";
import type { Runtime } from "./runtime.js";
import { Config } from "./config.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

function mustGetenv(key: string, componentId = ""): string {
  const v = process.env[key];
  if (v === undefined) {
    exitf(componentId || process.env.COMPONENT_ID || "", `必需的环境变量 ${key} 未设置`);
  }
  return v as string;
}

function exitf(componentId: string, message: string): never {
  const prefix = componentId ? `[${componentId}] ` : "";
  process.stderr.write(prefix + message + "\n");
  process.exit(1);
}

/**
 * 把当前进程环境变量拍成一份快照灌进 Config。
 *
 * ⚠️ 合并态下这个函数不会被调用——外壳启动器会给每个模块构造自己那
 * 一份 env map（§13.8.2），不是从共享的 `process.env` 里读。
 */
function envSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface OwnPorts {
  httpPort: number;
}

/**
 * 读自己的 component.yaml 拿端口（对应 manifest.go/manifest.py）。
 *
 * ⚠️ 端口不是平台注入的（§13.8.1）：环境变量表里只有"别人在哪"，没有
 * "我该监听哪"。唯一权威来源是组件自己的 component.yaml。
 *
 * ⚠️ 这里故意只做最小 YAML 解析（正则抓 `port:` 一行），不引入一个
 * YAML 依赖——be-sdk-ts 目前唯一需要读的字段就是这一个数字，为它加一整
 * 个解析库不划算（同 SOP-P 的判据：逻辑本身简单却硬套依赖是更糟的
 * 结果）。**这条判断随后如果 component.yaml 需要读更多字段会过时**，
 * 到时候换成真的 YAML 解析器，不要在这个正则上继续叠补丁。
 */
function loadOwnPorts(path = "component.yaml"): OwnPorts {
  const text = readFileSync(path, "utf-8");
  const match = /deployment:[\s\S]*?\n\s*port:\s*(\d+)/.exec(text);
  if (!match) {
    throw new Error(`未能从 ${path} 解析出 deployment.port`);
  }
  return { httpPort: Number.parseInt(match[1]!, 10) };
}

/**
 * 做进程级、只能有一份的那些初始化（OTel provider、日志根）。调用方
 * （`runStandalone` 或外壳）调它恰好一次；模块一律不许碰（设计书
 * §12.5.2）。
 *
 * ⚠️ 依赖 `otel.ts` 的 `initOtel`，那个函数目前只有签名，调用会抛异常
 * ——这是预期行为，随后的 TDD 任务会补上。这个函数本身的结构现在就要
 * 钉死（总纲 SOP-L L-1）。
 */
export async function bootstrap(
  componentId: string,
  otelBaseUrl: string,
): Promise<() => Promise<void>> {
  const { initOtel } = await import("./otel.js");
  return initOtel(componentId, otelBaseUrl);
}

export async function runStandalone(
  newModule: (rt: Runtime) => Promise<Module>,
): Promise<void> {
  const componentId = mustGetenv("COMPONENT_ID");
  const componentVersion = mustGetenv("COMPONENT_VERSION");

  const ports = loadOwnPorts("component.yaml");

  const shutdownOtel = await bootstrap(componentId, process.env.OTEL_BASE_URL ?? "");

  const { newLogger } = await import("./logging.js");
  const { newRegistry } = await import("./metrics.js");
  const { getTracer, getMeter } = await import("./otel.js");

  const rt: Runtime = {
    componentId,
    componentVersion,
    config: new Config(envSnapshot()),
    logger: newLogger(componentId),
    tracer: getTracer(componentId),
    meter: getMeter(componentId),
    registry: newRegistry(),
    httpPort: ports.httpPort,
  };

  const mod = await newModule(rt);

  const controller = new AbortController();
  // Yoga 直接兼容 Node 的 http.createServer 签名，官方用法就是这样，不用转换。
  const server = createServer(mod.httpHandler);

  const startTasks: Promise<void>[] = [];
  if (mod.start) {
    startTasks.push(mod.start(controller.signal));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(rt.httpPort, () => resolve());
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    await Promise.race([
      Promise.allSettled(startTasks),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (mod.stop) {
      await mod.stop();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownOtel();
  };

  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
}

/**
 * Runtime——对应 be-sdk-go 的 `Runtime`、be-sdk-python 的 `Runtime`。
 *
 * ⚠️ **比 Go/Python 版明显薄，这是刻意的**（设计书 §5.10："be-sdk-ts
 * 只有一半"）：TS 组件（`infra-bff-mobile`）严禁直连 DB（§6.5 铁律），
 * `frontend-*` 更没有后端库可言。所以本文件**没有** `db` 字段（无
 * `withTx`）、**没有** `nats` 字段（bff-mobile 的设计计划 §4 确认零
 * NATS 依赖）。调用方交给模块的一切，只有身份、配置、可观测性三类。
 */

import type { Tracer, Meter } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { Registry } from "@prometheus-io/client";
import type { Config } from "./config.js";

export interface Runtime {
  componentId: string;
  componentVersion: string;
  /** ⭐ 模块读配置的唯一入口。不许 `process.env` */
  config: Config;
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
  /** ⭐ 每模块一个，不是默认全局那个 */
  registry: Registry;
  /** 从 component.yaml 来，不是环境变量注入（§13.8.1） */
  httpPort: number;
}

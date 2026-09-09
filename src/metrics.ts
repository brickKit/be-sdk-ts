/**
 * 每模块一个 Prometheus Registry——对应 be-sdk-go 的 metrics.go、
 * be-sdk-python 的 metrics.py。
 *
 * 用默认全局 registry 的症状：重复注册同名指标会抛异常——单跑 100%
 * 正常，进外壳第二个模块起来就崩（设计书 §12.5.2）。`runStandalone`
 * 调用它填 `Runtime.registry`，恰好一次。
 */

import { Registry } from "@prometheus-io/client";

export function newRegistry(): Registry {
  return new Registry();
}

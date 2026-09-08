/**
 * 每模块一个 Prometheus Registry——对应 be-sdk-go 的 metrics.go、
 * be-sdk-python 的 metrics.py。目前只有签名，TDD 补实现。
 */

import type { Registry } from "@prometheus-io/client";

/**
 * 给每个模块建一个独立的 Prometheus Registry（不是默认全局那个）。
 *
 * 用默认全局 registry 的症状：重复注册同名指标会抛异常——单跑 100%
 * 正常，进外壳第二个模块起来就崩（设计书 §12.5.2）。`runStandalone`
 * 调用它填 `Runtime.registry`，恰好一次。
 *
 * 实现随后用 TDD 补：核心场景是"合并态下 N 个模块各自调一次，互不冲突"。
 */
export function newRegistry(): Registry {
  throw new Error("阶段三 Task 2 后续 TDD 补");
}

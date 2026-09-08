/**
 * 结构化日志——对应 be-sdk-go 的 logging.go、be-sdk-python 的
 * logging.py。目前只有签名，TDD 补实现。
 */

import type { Logger } from "pino";

/**
 * 构造已注入 componentId 与 trace 上下文的结构化 JSON 日志根
 * （设计书 §7.3）。`bootstrap` 调用它填 `Runtime.logger`，恰好一次
 * ——模块自己不许重新初始化（§12.5.2：最后一个 init 的赢）。
 *
 * ⚠️ 守三条：① 输出是合法 JSON；② 每条日志能拿到当前 span 就自动带
 * trace_id/span_id；③ 大字段截断到 2KB，已知敏感字段脱敏。
 *
 * 实现随后用 TDD 补。
 */
export function newLogger(_componentId: string): Logger {
  throw new Error("阶段三 Task 2 后续 TDD 补");
}

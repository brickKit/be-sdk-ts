/**
 * 结构化日志——对应 be-sdk-go 的 logging.go、be-sdk-python 的
 * logging.py。
 *
 * ⚠️ 同 be-sdk-python 的既有设计决策（同一个理由这里再成立一次）：不像
 * Go 版那样靠调用方手动调一个 `RedactPII` helper，这里的 `newLogger`
 * 构造出来的 logger **自动**对每一条日志的完整渲染文本做脱敏
 * （已知敏感字段）与截断（2KB），不需要调用方多做一步。做法是在 pino
 * 的输出流这一层拦一次——pino 每次 `write()` 收到的就是一整行已经
 * 序列化好的 JSON 文本，在那上面做字符串级的正则替换/截断，跟
 * Python 版"对完整渲染出来的 JSON 文本做正则"是同一个心智模型，
 * 只是 Python 操作的是 `str`、这里操作的是 pino 吐出来的那一行。
 * 脱敏占位符/截断后缀与 Python 版逐字一致（`[REDACTED]`/
 * `...[TRUNCATED]`），跨语言运维排障时不用记两套标记。
 *
 * ⚠️ **"两次 `newLogger` 同名会不会互相污染 handler"这条 Python 版的坑
 * 在这里不成立**：Python 的 `logging.getLogger(name)` 是按名字的全局
 * 单例注册表，两次用同一个名字构造会拿到同一个 logger 对象、handler
 * 会叠加；pino 没有这种机制——`pino(options, dest)` 每次调用都造一个
 * 全新的独立实例，没有名字 registry，天然不会有这个问题。这里刻意留
 * 一句说明，免得以后有人照抄 Python 版那条"不用 getLogger 用 Logger()
 * 绕开单例"的注释、以为 TS 也要做点什么特殊处理。
 */

import pino, { type Logger, type DestinationStream } from "pino";
import { trace, isSpanContextValid } from "@opentelemetry/api";

const MAX_LOGGED_PAYLOAD = 2048;
const TRUNCATED_SUFFIX = "...[TRUNCATED]";
const REDACTED_VALUE = "[REDACTED]";

// 已知敏感字段——同 be-sdk-python logging.py 的 _PII_FIELD_RE 逐字对应。
const PII_FIELD_RE = /"(phone|mobile|id_card|password|bank_card|email)"\s*:\s*"[^"]*"/g;

function redactAndTruncate(line: string): string {
  const trailingNewline = line.endsWith("\n");
  const body = trailingNewline ? line.slice(0, -1) : line;

  const redacted = body.replace(
    PII_FIELD_RE,
    (_match, field: string) => `"${field}":"${REDACTED_VALUE}"`,
  );

  const result =
    redacted.length <= MAX_LOGGED_PAYLOAD
      ? redacted
      : `${redacted.slice(0, MAX_LOGGED_PAYLOAD - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;

  return trailingNewline ? `${result}\n` : result;
}

class RedactingDestination implements DestinationStream {
  constructor(private readonly inner: DestinationStream) {}

  write(msg: string): void {
    this.inner.write(redactAndTruncate(msg));
  }
}

/**
 * `newLogger` 的可测版本——不写死 `process.stdout`，调用方传一个 pino
 * 认得的 `DestinationStream`（同 be-sdk-python 的 `_build_logger(stream,
 * component_id)`，测试用内存流验证，不用真的读写 stdout）。
 */
export function buildLogger(destination: DestinationStream, componentId: string): Logger {
  return pino(
    {
      base: { component_id: componentId },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      mixin() {
        const span = trace.getActiveSpan();
        if (!span) return {};
        const spanContext = span.spanContext();
        if (!isSpanContextValid(spanContext)) return {};
        return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
      },
    },
    new RedactingDestination(destination),
  );
}

/**
 * 构造已注入 componentId 与 trace 上下文的结构化 JSON 日志根
 * （设计书 §7.3）。`bootstrap` 调用它填 `Runtime.logger`，恰好一次
 * ——模块自己不许重新初始化（§12.5.2：最后一个 init 的赢）。
 *
 * 守三条：① 输出是合法 JSON（截断之前）；② 每条日志能拿到当前 span
 * 就自动带 trace_id/span_id；③ 大字段截断到 2KB，已知敏感字段脱敏。
 */
export function newLogger(componentId: string): Logger {
  return buildLogger(pino.destination(1), componentId);
}

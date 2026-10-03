// The member's JSON logger (P18.2): stdout, one object per line, envelope fields, automatic redaction,
// 2 KiB lines. pino is the locked library; fields of the current request / event / job come from `context`.
import { pino, type Logger, type DestinationStream } from "pino";
import { redactRecord } from "./redact.js";
import { truncateLine } from "./truncate.js";

export type { Logger } from "pino";

export interface LoggerOptions {
  componentId: string;
  componentVersion: string;
  level: "debug" | "info" | "warn" | "error";
  /** fields of the current unit of work (trace_id, span_id, request_id, sub, …) */
  context?: () => Record<string, unknown>;
  destination?: { write(s: string): unknown };
}

const startNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

/** RFC 3339 UTC with nanoseconds. */
export function nowRfc3339Nano(): string {
  const ns = startNs + process.hrtime.bigint();
  const iso = new Date(Number(ns / 1_000_000n)).toISOString();
  return `${iso.slice(0, 19)}.${String(ns % 1_000_000_000n).padStart(9, "0")}Z`;
}

class LineSink implements DestinationStream {
  private readonly out: { write(s: string): unknown };
  constructor(out: { write(s: string): unknown }) {
    this.out = out;
  }
  write(s: string): void {
    const line = s.endsWith("\n") ? s.slice(0, -1) : s;
    this.out.write(truncateLine(line) + "\n");
  }
}

export function newLogger(o: LoggerOptions): Logger {
  return pino(
    {
      level: o.level,
      messageKey: "msg",
      base: { component_id: o.componentId, component_version: o.componentVersion },
      timestamp: () => `,"time":"${nowRfc3339Nano()}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redactRecord(obj),
      },
      mixin: o.context,
    },
    new LineSink(o.destination ?? process.stdout),
  );
}

/** The `error`, `error.code`, `error.reason` fields of a log line (P18.2). */
export function errorFields(err: unknown): Record<string, string> {
  const e = err as { message?: string; code?: unknown; reason?: unknown };
  const out: Record<string, string> = { error: String(e?.message ?? err) };
  if (typeof e?.code === "string") out["error.code"] = e.code;
  if (typeof e?.reason === "string" && e.reason !== "") out["error.reason"] = e.reason;
  return out;
}

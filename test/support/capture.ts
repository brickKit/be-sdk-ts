import { Writable } from "node:stream";
import { newLogger } from "../../src/log/logger.js";

/** A member logger whose lines are parsed into `lines`. */
export function captureLogger(componentId = "sdktest/basic", level: "debug" | "info" | "warn" | "error" = "info") {
  const lines: any[] = [];
  const destination = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
  return { lines, logger: newLogger({ componentId, componentVersion: "3.0.0", level, destination }) };
}

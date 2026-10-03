import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runVectors } from "../../support/vectors.js";
import { isProtectedKey, redactRecord } from "../../../src/log/redact.js";
import { truncateLine, MAX_LINE_BYTES } from "../../../src/log/truncate.js";
import { newLogger } from "../../../src/log/logger.js";

describe("redaction vectors", () => {
  runVectors("redaction", "redact", {
    redact: (i) => ({ record: redactRecord(i.record) }),
    protected_key: (i) => ({ protected: isProtectedKey(i.key) }),
  });
});

describe("line truncation", () => {
  it("keeps a long line one valid JSON object, cutting the longest values first", () => {
    const rec = { time: "t", level: "info", msg: "m", component_id: "a/b", note: "x".repeat(5000), other: "y".repeat(300), small: "z" };
    const out = truncateLine(JSON.stringify(rec));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const back = JSON.parse(out);
    expect(back.truncated).toBe(true);
    expect(back.note.endsWith("…[TRUNCATED]")).toBe(true);
    expect(back.msg).toBe("m");
    expect(back.small).toBe("z");
  });

  it("leaves a short line alone", () => {
    const line = JSON.stringify({ msg: "hi" });
    expect(truncateLine(line)).toBe(line);
  });

  it("cuts at a character boundary", () => {
    const out = truncateLine(JSON.stringify({ msg: "m", note: "中".repeat(2000) }));
    expect(JSON.parse(out).note).toMatch(/^中+…\[TRUNCATED\]$/);
  });
});

function capture() {
  const lines: any[] = [];
  const dest = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
  return { lines, dest };
}

describe("logger", () => {
  it("writes the envelope fields and redacts personal data", () => {
    const { lines, dest } = capture();
    const log = newLogger({ componentId: "sdktest/basic", componentVersion: "3.0.0", level: "info", destination: dest });
    log.info({ contact_phone: "13800138000", nested: { accessToken: "t" } }, "hello");
    log.debug("hidden");
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l).toMatchObject({ level: "info", msg: "hello", component_id: "sdktest/basic", component_version: "3.0.0", contact_phone: "[REDACTED]", nested: { accessToken: "[REDACTED]" } });
    expect(l.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/);
  });

  it("honours LOG_LEVEL warn", () => {
    const { lines, dest } = capture();
    const log = newLogger({ componentId: "a/b", componentVersion: "1.0.0", level: "warn", destination: dest });
    log.info("no");
    log.warn("yes");
    expect(lines.map((l) => l.level)).toEqual(["warn"]);
  });
});

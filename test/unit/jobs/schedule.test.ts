// Schedules (P14.6): five-field cron in BUSINESS_TIMEZONE (or the job's zone), or `@every <Go duration>` ≥ 1 s
// whose slots are multiples since the epoch; nothing else.
import { describe, expect, it } from "vitest";
import { nextSlotAfter, parseSchedule, slotAtOrBefore } from "../../../src/jobs/schedule.js";

const at = (iso: string) => new Date(iso);

describe("parseSchedule", () => {
  it("accepts five-field cron and @every of at least 1 s", () => {
    for (const s of ["0 3 * * *", "*/15 * * * *", "0-30/10 8-18 * * 1-5", "0 0 1,15 * *", "5 4 * jan,jul sun", "0 0 * * 7"]) expect(() => parseSchedule(s)).not.toThrow();
    expect(parseSchedule("@every 90s")).toEqual({ kind: "every", ms: 90_000 });
    expect(parseSchedule("@every 1m30s")).toEqual({ kind: "every", ms: 90_000 });
  });
  it("refuses everything else", () => {
    for (const s of ["@daily", "@reboot", "@hourly", "0 0 3 * * *", "* * * *", "61 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "@every 500ms", "@every 1x", "", "*/0 * * * *"]) {
      expect(() => parseSchedule(s), s).toThrow();
    }
  });
});

describe("@every slots are multiples of the duration since the epoch", () => {
  const s = parseSchedule("@every 10s");
  it("slot at or before, next after", () => {
    expect(slotAtOrBefore(s, at("2026-10-03T12:00:07Z"), "UTC")).toEqual(at("2026-10-03T12:00:00Z"));
    expect(slotAtOrBefore(s, at("2026-10-03T12:00:10Z"), "UTC")).toEqual(at("2026-10-03T12:00:10Z"));
    expect(nextSlotAfter(s, at("2026-10-03T12:00:10Z"), "UTC")).toEqual(at("2026-10-03T12:00:20Z"));
  });
});

describe("cron in a zone", () => {
  it("evaluates in the zone (Asia/Shanghai, UTC+8)", () => {
    const s = parseSchedule("0 3 * * *");
    expect(slotAtOrBefore(s, at("2026-10-03T00:00:00Z"), "Asia/Shanghai")).toEqual(at("2026-10-02T19:00:00Z"));
    expect(nextSlotAfter(s, at("2026-10-02T19:00:00Z"), "Asia/Shanghai")).toEqual(at("2026-10-03T19:00:00Z"));
  });
  it("steps, ranges and lists", () => {
    const s = parseSchedule("*/15 9-10 * * *");
    expect(nextSlotAfter(s, at("2026-10-03T09:50:00Z"), "UTC")).toEqual(at("2026-10-03T10:00:00Z"));
    expect(nextSlotAfter(s, at("2026-10-03T10:45:00Z"), "UTC")).toEqual(at("2026-10-04T09:00:00Z"));
  });
  it("day of month OR day of week when both are restricted", () => {
    const s = parseSchedule("0 0 1 * mon"); // the 1st, and every Monday
    expect(nextSlotAfter(s, at("2026-10-01T00:00:00Z"), "UTC")).toEqual(at("2026-10-05T00:00:00Z")); // Monday
    expect(nextSlotAfter(s, at("2026-10-26T00:00:00Z"), "UTC")).toEqual(at("2026-11-01T00:00:00Z"));
  });
  it("skips a wall time that does not exist and runs an ambiguous one once (its first occurrence)", () => {
    const s = parseSchedule("30 2 * * *");
    // 2026-03-29: Berlin jumps 02:00 → 03:00
    expect(nextSlotAfter(s, at("2026-03-28T02:00:00Z"), "Europe/Berlin")).toEqual(at("2026-03-30T00:30:00Z"));
    // 2026-10-25: 02:30 happens at 00:30Z (CEST) and 01:30Z (CET)
    expect(nextSlotAfter(s, at("2026-10-24T12:00:00Z"), "Europe/Berlin")).toEqual(at("2026-10-25T00:30:00Z"));
    expect(nextSlotAfter(s, at("2026-10-25T00:30:00Z"), "Europe/Berlin")).toEqual(at("2026-10-26T01:30:00Z"));
  });
  it("finds a rare slot (29 February) within a few years", () => {
    const s = parseSchedule("0 0 29 2 *");
    expect(slotAtOrBefore(s, at("2026-10-03T00:00:00Z"), "UTC")).toEqual(at("2024-02-29T00:00:00Z"));
    expect(nextSlotAfter(s, at("2026-10-03T00:00:00Z"), "UTC")).toEqual(at("2028-02-29T00:00:00Z"));
  });
});

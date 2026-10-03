import { describe, expect, it } from "vitest";
import { addSpan, anchorFiscalYearEnd, compareMin, parseAfter, parseSpan } from "../../../src/lifecycle/duration.js";
import { grainAdd, grainStart, rangeWindow } from "../../../src/migrate/window.js";

const d = (s: string) => new Date(s);

describe("lifecycle durations", () => {
  it("parses spans and anchored spans", () => {
    expect(parseSpan("90d")).toEqual({ n: 90, unit: "d" });
    expect(parseSpan("18mo")).toEqual({ n: 18, unit: "mo" });
    expect(parseAfter("10y after closed")).toEqual({ span: { n: 10, unit: "y" }, anchor: "closed" });
    expect(parseAfter("forever")).toBe("forever");
    expect(parseAfter("never")).toBe("never");
    expect(() => parseSpan("3h")).toThrow();
  });

  it("adds calendar spans in UTC, clamping the day of month like PostgreSQL", () => {
    expect(addSpan(d("2026-01-31T00:00:00Z"), { n: 1, unit: "mo" }).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addSpan(d("2024-02-29T12:00:00Z"), { n: 1, unit: "y" }).toISOString()).toBe("2025-02-28T12:00:00.000Z");
    expect(addSpan(d("2026-10-03T00:00:00Z"), { n: 2, unit: "w" }).toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(addSpan(d("2026-10-03T00:00:00Z"), { n: 30, unit: "d" }).toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("fiscal_year_end: the natural year ends at 1 January 00:00 UTC of the next year (counting starts the day after)", () => {
    expect(anchorFiscalYearEnd(d("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(anchorFiscalYearEnd(d("2026-01-01T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("compareMin: an override may only lengthen a minimum", () => {
    expect(compareMin("15y after closed", "10y after closed")).toBe("longer_or_equal");
    expect(compareMin("5y after closed", "10y after closed")).toBe("shorter");
    expect(compareMin("forever", "10y after closed")).toBe("longer_or_equal");
    expect(compareMin("10y after closed", "forever")).toBe("shorter");
    expect(compareMin("4000d after closed", "10y after closed")).toBe("longer_or_equal");
    expect(compareMin("3000d after closed", "10y after closed")).toBe("shorter");
    expect(compareMin("12mo after created", "1y after created")).toBe("longer_or_equal");
    expect(compareMin("10y after created", "10y after closed")).toBe("incomparable");
  });
});

describe("partition grains (UTC boundaries)", () => {
  it("starts weeks on Monday, months on the 1st, years on 1 January", () => {
    expect(grainStart(d("2026-10-03T12:00:00Z"), "week").toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(grainStart(d("2026-10-03T12:00:00Z"), "month").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(grainStart(d("2026-10-03T12:00:00Z"), "year").toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(grainAdd(d("2026-12-01T00:00:00Z"), "month", 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("a window is the current period and `ahead` more, named <table>_p<YYYYMMDD of the lower bound>", () => {
    const w = rangeWindow("widgets", "month", 3, d("2026-10-03T12:00:00Z"));
    expect(w.map((p) => p.name)).toEqual(["widgets_p20261001", "widgets_p20261101", "widgets_p20261201", "widgets_p20270101"]);
    expect(w[3]!.to.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });
});

// P16.3: the read window of a List and RANGE_COLD.
import { describe, expect, it } from "vitest";
import { isBeError, type BeError } from "../../../src/errors/beError.js";
import { parseDataLifecycle } from "../../../src/lifecycle/config.js";
import { effectiveTables, loadDeclaration } from "../../../src/lifecycle/declaration.js";
import { readWindow } from "../../../src/lifecycle/window.js";

const decl = loadDeclaration(new URL("../../fixtures/lifecycle/widget/migrations/", import.meta.url).pathname);
const t = effectiveTables(decl);
const cfg = parseDataLifecycle(undefined, decl);
const d = (s: string) => new Date(s);
const now = d("2026-10-03T00:00:00Z");

function caught(fn: () => unknown): BeError {
  try {
    fn();
  } catch (e) {
    if (isBeError(e)) return e;
    throw e;
  }
  throw new Error("expected a BeError");
}

describe("readWindow", () => {
  it("a list without a range reads the table's hot window", () => {
    expect(readWindow(t.get("widgets")!, {}, false, [], now, cfg)).toEqual({ from: d("2026-07-05T00:00:00Z"), to: undefined });
  });

  it("hot: none (and no hot tier) means no window", () => {
    expect(readWindow(t.get("widget_owners")!, {}, false, [], now, cfg)).toEqual({ from: undefined, to: undefined });
    expect(readWindow(t.get("widget_kinds")!, {}, false, [], now, cfg)).toEqual({ from: undefined, to: undefined });
  });

  it("a named range is returned whole: warm rows older than the hot window are read", () => {
    const r = { from: d("2020-01-01T00:00:00Z"), to: d("2021-01-01T00:00:00Z") };
    expect(readWindow(t.get("widgets")!, r, false, [], now, cfg)).toEqual(r);
  });

  it("TestWindow_range_crosses_cold: RANGE_COLD with online_from, cold_ranges, thaw_allowed, export_allowed", () => {
    const cold = [
      { unitKey: "widgets_p20200201", from: d("2020-02-01T00:00:00Z"), to: d("2020-03-01T00:00:00Z"), state: "COLD" as const },
      { unitKey: "widgets_p20200101", from: d("2020-01-01T00:00:00Z"), to: d("2020-02-01T00:00:00Z"), state: "COLD" as const },
    ];
    const e = caught(() => readWindow(t.get("widgets")!, { from: d("2019-06-01T00:00:00Z") }, false, cold, now, cfg));
    expect(e.code).toBe("FAILED_PRECONDITION");
    expect(e.reason).toBe("RANGE_COLD");
    expect(e.metadata).toEqual({
      online_from: "2020-03-01T00:00:00.000Z",
      cold_ranges: "2020-01-01T00:00:00.000Z/2020-02-01T00:00:00.000Z,2020-02-01T00:00:00.000Z/2020-03-01T00:00:00.000Z",
      thaw_allowed: "false",
      export_allowed: "false",
    });
    // include_cold cannot be served without a cold query adapter: still RANGE_COLD, never a silent truncation
    expect(caught(() => readWindow(t.get("widgets")!, { from: d("2019-06-01T00:00:00Z") }, true, cold, now, cfg)).reason).toBe("RANGE_COLD");
    // a range after the cold units is complete
    expect(readWindow(t.get("widgets")!, { from: d("2020-03-01T00:00:00Z") }, false, cold, now, cfg).from).toEqual(d("2020-03-01T00:00:00Z"));
  });
});

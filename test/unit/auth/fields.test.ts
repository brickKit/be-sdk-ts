// Field masks (be-protocol P6.8, EVALUATION.md E11): masked columns are null and listed in `_masked`; a write to a
// masked or read-only column is 403 FIELD_FORBIDDEN; sorting or filtering by a masked column is 400 SORT_FORBIDDEN.
import { describe, expect, it } from "vitest";
import { isBeError } from "../../../src/errors/beError.js";
import { checkSortable, checkWritable, maskRows } from "../../../src/auth/fields.js";

const access = { masked: ["discount", "unit_price"], readOnly: ["note"] };

function thrown(fn: () => void): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("maskRows", () => {
  it("nulls masked columns and lists them in _masked, without touching the input", () => {
    const rows = [{ id: "o1", unit_price: "9.50", discount: "0.1", note: "x" }, { id: "o2", note: "y" }];
    expect(maskRows(rows, access.masked)).toEqual([
      { id: "o1", unit_price: null, discount: null, note: "x", _masked: ["discount", "unit_price"] },
      { id: "o2", unit_price: null, discount: null, note: "y", _masked: ["discount", "unit_price"] },
    ]);
    expect(rows[0]!.unit_price).toBe("9.50");
  });
  it("adds an empty _masked when nothing is masked", () => {
    expect(maskRows([{ id: "o1" }], [])).toEqual([{ id: "o1", _masked: [] }]);
  });
});

describe("checkWritable", () => {
  it("allows ordinary columns", () => expect(() => checkWritable(access, ["status", "qty"])).not.toThrow());
  it.each(["unit_price", "note"])("refuses %s with FIELD_FORBIDDEN", (col) => {
    const e = thrown(() => checkWritable(access, ["status", col]));
    expect(isBeError(e)).toBe(true);
    expect([e.code, e.reason, e.domain, e.metadata]).toEqual(["PERMISSION_DENIED", "FIELD_FORBIDDEN", "be", { field: col }]);
  });
  it("names the first offending column by byte order", () => {
    expect(thrown(() => checkWritable(access, ["unit_price", "discount"])).metadata).toEqual({ field: "discount" });
  });
});

describe("checkSortable", () => {
  it("allows a read-only or ordinary column", () => expect(() => checkSortable(access, "note", "created_at")).not.toThrow());
  it("refuses a masked column with SORT_FORBIDDEN", () => {
    const e = thrown(() => checkSortable(access, "created_at", "discount"));
    expect([e.code, e.reason, e.domain, e.metadata]).toEqual(["INVALID_ARGUMENT", "SORT_FORBIDDEN", "be", { field: "discount" }]);
  });
});

// Field masks (be-protocol P6.8, EVALUATION.md E11) applied to rows and requests. `Evaluator.fields(type)` says
// which columns are masked or read-only; these helpers enforce it: masked columns leave the component as `null`
// listed in `_masked`, a write to a masked or read-only column is 403 FIELD_FORBIDDEN, and sorting, filtering or
// aggregating by a masked column is 400 SORT_FORBIDDEN.
import { platformError } from "../errors/beError.js";
import { sortUnique, type FieldAccess } from "./evaluate.js";

export type Masked<T> = Omit<T, "_masked"> & { _masked: string[] };

/** Copies of the rows with every masked column set to `null` and the sorted masked columns in `_masked`. */
export function maskRows<T extends Record<string, unknown>>(rows: readonly T[], masked: readonly string[]): Masked<T>[] {
  const cols = sortUnique(masked);
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const c of cols) out[c] = null;
    out._masked = [...cols];
    return out as Masked<T>;
  });
}

/** A write (create or update) may not set a masked or read-only column: 403 FIELD_FORBIDDEN naming the column. */
export function checkWritable(access: FieldAccess, changedColumns: Iterable<string>): void {
  const forbidden = new Set([...access.masked, ...access.readOnly]);
  const hit = sortUnique(changedColumns).find((c) => forbidden.has(c));
  if (hit !== undefined) throw platformError("FIELD_FORBIDDEN", { field: hit });
}

/** Sorting, filtering or aggregating by a masked column: 400 SORT_FORBIDDEN naming the column. */
export function checkSortable(access: FieldAccess, ...columns: string[]): void {
  const masked = new Set(access.masked);
  const hit = sortUnique(columns).find((c) => masked.has(c));
  if (hit !== undefined) throw platformError("SORT_FORBIDDEN", { field: hit });
}

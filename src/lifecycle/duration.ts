// Durations of lifecycle.yaml (P16.1): `<n>(d|w|mo|y)`, optionally `after <anchor>`; calendar arithmetic in UTC,
// month and year steps clamped to the last day of the month as PostgreSQL's interval arithmetic does.
import type { Anchor } from "./types.js";

export type SpanUnit = "d" | "w" | "mo" | "y";
export interface Span {
  n: number;
  unit: SpanUnit;
}
export interface After {
  span: Span;
  anchor: Anchor;
}

const SPAN = /^([1-9][0-9]*)(d|w|mo|y)$/;
const AFTER = /^([1-9][0-9]*(?:d|w|mo|y)) after (created|closed|sealed|fiscal_year_end)$/;
const DAY_MS = 86_400_000;

export function parseSpan(s: string): Span {
  const m = SPAN.exec(s);
  if (!m) throw new Error(`not a duration: ${JSON.stringify(s)}`);
  return { n: Number(m[1]), unit: m[2] as SpanUnit };
}

/** `<n><unit> after <anchor>`, or the literal `forever` / `never`. */
export function parseAfter(s: string): After | "forever" | "never" {
  if (s === "forever" || s === "never") return s;
  const m = AFTER.exec(s);
  if (!m) throw new Error(`not "<duration> after <anchor>": ${JSON.stringify(s)}`);
  return { span: parseSpan(m[1]!), anchor: m[2] as Anchor };
}

function addMonths(t: Date, months: number): Date {
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(t.getUTCDate(), last);
  return new Date(Date.UTC(y, m, day, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()));
}

export function addSpan(t: Date, s: Span): Date {
  switch (s.unit) {
    case "d":
      return new Date(t.getTime() + s.n * DAY_MS);
    case "w":
      return new Date(t.getTime() + s.n * 7 * DAY_MS);
    case "mo":
      return addMonths(t, s.n);
    case "y":
      return addMonths(t, 12 * s.n);
  }
}

export function subtractSpan(t: Date, s: Span): Date {
  if (s.unit === "d" || s.unit === "w") return addSpan(t, { n: -s.n, unit: s.unit });
  return addMonths(t, -(s.unit === "y" ? 12 * s.n : s.n));
}

/** The end of the natural (UTC) year containing `t`: 1 January 00:00 of the next year, the first day counted. */
export function anchorFiscalYearEnd(t: Date): Date {
  return new Date(Date.UTC(t.getUTCFullYear() + 1, 0, 1));
}

const months = (s: Span) => (s.unit === "y" ? 12 * s.n : s.unit === "mo" ? s.n : undefined);
const days = (s: Span) => (s.unit === "w" ? 7 * s.n : s.unit === "d" ? s.n : undefined);
const minDaysOfMonths = (m: number) => 365 * Math.floor(m / 12) + 28 * (m % 12);
const maxDaysOfMonths = (m: number) => 366 * Math.floor(m / 12) + 31 * (m % 12);

/**
 * Whether `override` is at least as long as `declared` for every starting instant (P16.9). Spans of months and
 * of days are compared conservatively: an override that is not provably as long counts as shorter.
 */
export function compareMin(override: string, declared: string): "longer_or_equal" | "shorter" | "incomparable" {
  const o = parseAfter(override);
  const d = parseAfter(declared);
  if (o === "forever") return "longer_or_equal";
  if (d === "forever" || d === "never") return d === "never" ? "longer_or_equal" : "shorter";
  if (o === "never") return "shorter";
  if (o.anchor !== d.anchor) return "incomparable";
  const [om, dm, od, dd] = [months(o.span), months(d.span), days(o.span), days(d.span)];
  let ok: boolean;
  if (om !== undefined && dm !== undefined) ok = om >= dm;
  else if (od !== undefined && dd !== undefined) ok = od >= dd;
  else if (om !== undefined) ok = minDaysOfMonths(om) >= dd!;
  else ok = od! >= maxDaysOfMonths(dm!);
  return ok ? "longer_or_equal" : "shorter";
}

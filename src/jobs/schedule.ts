// Schedules (P14.6): a five-field cron expression evaluated in an IANA zone, or `@every <Go duration>` (≥ 1 s)
// whose slots are the multiples of the duration since the Unix epoch, so every replica computes the same slots.
// Nothing else (no seconds field, no @daily, no @reboot). A wall time that does not exist (DST gap) is skipped; an
// ambiguous one (DST overlap) is its first occurrence, so a slot never runs twice.
import { ConfigError } from "../config/configError.js";
import { nsToMs, parseDurationNs } from "../config/duration.js";

interface Cron {
  kind: "cron";
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

export type Schedule = Cron | { kind: "every"; ms: number };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SEARCH_DAYS = 366 * 8;

function invalid(expr: string, why: string): ConfigError {
  return new ConfigError("CONFIG_INVALID", "schedule", `not a schedule (${why}): ${JSON.stringify(expr)}`);
}

export function parseSchedule(expr: string): Schedule {
  const e = expr.trim();
  if (e.startsWith("@every ")) {
    let ns: bigint;
    try {
      ns = parseDurationNs("schedule", e.slice(7).trim());
    } catch {
      throw invalid(expr, "bad duration");
    }
    if (ns < 1_000_000_000n) throw invalid(expr, "@every needs at least 1s");
    return { kind: "every", ms: nsToMs(ns) };
  }
  const f = e.split(/\s+/);
  if (f.length !== 5 || e === "") throw invalid(expr, "five fields");
  const dow = field(expr, f[4]!, 0, 7, DAYS);
  if (dow.has(7)) (dow.delete(7), dow.add(0));
  return {
    kind: "cron", minute: field(expr, f[0]!, 0, 59), hour: field(expr, f[1]!, 0, 23), dom: field(expr, f[2]!, 1, 31),
    month: field(expr, f[3]!, 1, 12, MONTHS, 1), dow, domAny: f[2] === "*", dowAny: f[4] === "*",
  };
}

function field(expr: string, text: string, lo: number, hi: number, names: string[] = [], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    const i = names.indexOf(s.toLowerCase());
    const v = i >= 0 ? i + nameBase : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!(v >= lo && v <= hi)) throw invalid(expr, `${s} outside ${lo}-${hi}`);
    return v;
  };
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw invalid(expr, `bad step in ${part}`);
    let [a, b] = [lo, hi];
    if (range !== "*") {
      const [x = "", y] = range.split("-");
      a = num(x);
      b = y === undefined ? (stepText === undefined ? a : hi) : num(y);
      if (b < a) throw invalid(expr, `bad range ${range}`);
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** The latest slot at or before `now`. */
export function slotAtOrBefore(s: Schedule, now: Date, zone: string): Date {
  if (s.kind === "every") return new Date(Math.floor(now.getTime() / s.ms) * s.ms);
  const today = wallDate(now, zone);
  for (let d = 0; d < SEARCH_DAYS; d++) {
    const day = addDays(today, -d);
    if (!dayMatches(s, day)) continue;
    for (const h of [...s.hour].sort((x, y) => y - x)) {
      for (const m of [...s.minute].sort((x, y) => y - x)) {
        const t = instantOf(day, h, m, zone);
        if (t && t.getTime() <= now.getTime()) return t;
      }
    }
  }
  throw new Error("no slot within eight years");
}

/** The first slot strictly after `t`. */
export function nextSlotAfter(s: Schedule, t: Date, zone: string): Date {
  if (s.kind === "every") return new Date((Math.floor(t.getTime() / s.ms) + 1) * s.ms);
  const start = wallDate(t, zone);
  for (let d = -1; d < SEARCH_DAYS; d++) {
    const day = addDays(start, d);
    if (!dayMatches(s, day)) continue;
    for (const h of [...s.hour].sort((x, y) => x - y)) {
      for (const m of [...s.minute].sort((x, y) => x - y)) {
        const c = instantOf(day, h, m, zone);
        if (c && c.getTime() > t.getTime()) return c;
      }
    }
  }
  throw new Error("no slot within eight years");
}

/** A calendar date as a UTC midnight (no zone involved). */
type Day = Date;

function dayMatches(s: Cron, day: Day): boolean {
  if (!s.month.has(day.getUTCMonth() + 1)) return false;
  const dom = s.dom.has(day.getUTCDate());
  const dow = s.dow.has(day.getUTCDay());
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dow;
  if (s.dowAny) return dom;
  return dom || dow; // both restricted: either (cron's classic rule)
}

function addDays(d: Day, n: number): Day {
  return new Date(d.getTime() + n * 86_400_000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(t: Date, zone: string): number[] {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute)];
}

function wallDate(t: Date, zone: string): Day {
  const [y, mo, d] = parts(t, zone);
  return new Date(Date.UTC(y!, mo! - 1, d!));
}

/** The earliest instant whose wall time in `zone` is day h:m; undefined when that wall time does not exist. */
function instantOf(day: Day, h: number, m: number, zone: string): Date | undefined {
  const wall = day.getTime() + h * 3_600_000 + m * 60_000;
  const hits: number[] = [];
  for (const offsetH of [-15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    for (const extraMin of [0, 30, 45]) {
      const cand = wall - (offsetH * 60 + Math.sign(offsetH || 1) * extraMin) * 60_000;
      const [y, mo, d, hh, mm] = parts(new Date(cand), zone);
      if (Date.UTC(y!, mo! - 1, d!, hh!, mm!) === wall) hits.push(cand);
    }
  }
  return hits.length === 0 ? undefined : new Date(Math.min(...hits));
}

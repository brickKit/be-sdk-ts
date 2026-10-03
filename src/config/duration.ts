// Go's time.ParseDuration syntax (P2.3; vectors config/values), without negative values. Nanoseconds as bigint.
import { ConfigError } from "./configError.js";

const UNITS: Record<string, bigint> = {
  ns: 1n, us: 1_000n, "µs": 1_000n, "μs": 1_000n, ms: 1_000_000n, s: 1_000_000_000n, m: 60_000_000_000n, h: 3_600_000_000_000n,
};
const MAX = 2n ** 63n - 1n;
const PART = /^([0-9]*)(?:\.([0-9]*))?([a-zµμ]+)/;

export function parseDurationNs(key: string, raw: string): bigint {
  const bad = () => new ConfigError("CONFIG_INVALID", key, `not a duration: ${JSON.stringify(raw)}`);
  let s = raw;
  if (s.startsWith("+")) s = s.slice(1);
  if (s === "0") return 0n;
  if (s === "") throw bad();
  let total = 0n;
  while (s !== "") {
    const m = PART.exec(s);
    if (!m) throw bad();
    const [all, int = "", frac, unitName = ""] = m;
    const unit = UNITS[unitName];
    if (unit === undefined || (int === "" && (frac === undefined || frac === ""))) throw bad();
    let v = BigInt(int || "0") * unit;
    if (frac) v += (BigInt(frac) * unit) / 10n ** BigInt(frac.length);
    total += v;
    if (total > MAX) throw bad();
    s = s.slice(all.length);
  }
  return total;
}

export function nsToMs(ns: bigint): number {
  return Number(ns / 1_000_000n);
}

// ce-time (P12): RFC 3339 in UTC with `Z`, fractional seconds only when non-zero, trailing zeros removed,
// at most 6 digits. JavaScript dates hold milliseconds, so the fraction is carried as text.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

export function isRfc3339(s: string): boolean {
  return RFC3339.test(s);
}

export function formatCeTime(s: string): string {
  const m = RFC3339.exec(s);
  if (!m) throw new Error(`not RFC 3339: ${s}`);
  const [, y, mo, d, h, mi, sec, frac = "", off] = m;
  let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +sec!);
  if (off !== "Z" && off !== "z") {
    const sign = off![0] === "-" ? -1 : 1;
    ms -= sign * (Number(off!.slice(1, 3)) * 60 + Number(off!.slice(4, 6))) * 60_000;
  }
  const base = new Date(ms).toISOString().slice(0, 19);
  const f = frac.slice(0, 6).replace(/0+$/, "");
  return f ? `${base}.${f}Z` : `${base}Z`;
}

/** An instant with microsecond text for an outbox row's `occurred_at`. */
export function nowCeTime(): string {
  return formatCeTime(new Date().toISOString());
}

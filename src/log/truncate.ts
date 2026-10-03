// P18.2: a log line is at most 2 KiB and stays one valid JSON object: string values outside the envelope are
// cut, longest first, at a character boundary, each ending in `…[TRUNCATED]`, and `truncated: true` is added.
import { ENVELOPE_FIELDS } from "./redact.js";

export const MAX_LINE_BYTES = 2048;
const MARK = "…[TRUNCATED]";

type Slot = { get: () => string; set: (s: string) => void };

function strings(v: unknown, out: Slot[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => (typeof x === "string" ? out.push({ get: () => v[i], set: (s) => (v[i] = s) }) : strings(x, out)));
  } else if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "string") out.push({ get: () => o[k] as string, set: (s) => (o[k] = s) });
      else strings(o[k], out);
    }
  }
}

export function truncateLine(line: string, max = MAX_LINE_BYTES): string {
  if (Buffer.byteLength(line) <= max) return line;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ msg: line.slice(0, 200) + MARK, truncated: true });
  }
  const slots: Slot[] = [];
  for (const k of Object.keys(rec)) {
    if (ENVELOPE_FIELDS.has(k)) continue;
    if (typeof rec[k] === "string") slots.push({ get: () => rec[k] as string, set: (s) => (rec[k] = s) });
    else strings(rec[k], slots);
  }
  rec.truncated = true;
  let out = JSON.stringify(rec);
  while (Buffer.byteLength(out) > max) {
    const longest = slots.reduce<Slot | undefined>((a, s) => (!a || s.get().length > a.get().length ? s : a), undefined);
    if (!longest || longest.get().length <= MARK.length) break;
    const cur = longest.get().endsWith(MARK) ? longest.get().slice(0, -MARK.length) : longest.get();
    const excess = Buffer.byteLength(out) - max;
    // each round shrinks the value by at least one byte; JSON escaping may need another round
    const budget = Math.min(Buffer.byteLength(cur) - excess - Buffer.byteLength(MARK), Buffer.byteLength(cur) - 1);
    let kept = "";
    let bytes = 0;
    for (const ch of cur) {
      bytes += Buffer.byteLength(ch);
      if (bytes > budget) break;
      kept += ch;
    }
    longest.set(kept + MARK);
    out = JSON.stringify(rec);
  }
  return out;
}

// The request fingerprint (P13.2): the declared fields as one JSON object, canonicalised with RFC 8785 (JCS),
// SHA-256 of the UTF-8 bytes. The input is parsed strictly (I-JSON): duplicate member names, NaN / Infinity and
// numbers that overflow a double are refused with JSON_INVALID, so two texts never share a fingerprint by accident.
import { createHash } from "node:crypto";

/** A refused input; `vectorReason` is the vectors' name for it. */
export class JsonInvalid extends Error {
  readonly vectorReason = "JSON_INVALID";
  constructor(why: string) {
    super(`not canonicalisable JSON: ${why}`);
    this.name = "JsonInvalid";
  }
}

/** JCS text of a JSON text (parsed strictly) or of a JS value (as JSON.stringify would see it). */
export function canonicalJson(input: string | unknown): string {
  const value = typeof input === "string" ? strictParse(input) : JSON.parse(JSON.stringify(input ?? null));
  return serialize(value);
}

/** SHA-256 of the JCS text: 32 bytes, stored as BYTEA. */
export function fingerprint(input: string | unknown): Uint8Array {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest();
}

function serialize(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new JsonInvalid("a number that is not finite");
    return Object.is(v, -0) ? "0" : String(v); // ES Number::toString is the JCS number form
  }
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort(); // default sort compares UTF-16 code units, as RFC 8785 §3.2.3 says
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(o[k])}`).join(",")}}`;
}

/** JSON.parse refuses what JSON forbids; members are checked for duplicates and numbers for overflow on the way. */
function strictParse(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JsonInvalid((e as Error).message);
  }
  checkDuplicates(text);
  serialize(value); // refuses 1e400 (Infinity after parsing)
  return value;
}

/** Scans the (already valid) text for an object holding the same member name twice. */
function checkDuplicates(text: string): void {
  const stack: (Set<string> | null)[] = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      if (expectKey) {
        const seen = stack.at(-1)!;
        const name = JSON.parse(text.slice(i, end)) as string;
        if (seen.has(name)) throw new JsonInvalid(`duplicate member ${JSON.stringify(name)}`);
        seen.add(name);
        expectKey = false;
      }
      i = end;
      continue;
    }
    if (c === "{") (stack.push(new Set()), (expectKey = true));
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") expectKey = stack.at(-1) instanceof Set;
    i++;
  }
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

// Automatic redaction of personal-data keys in log records (P18.2; vectors redaction, normative).
const PROTECTED = ["phone", "mobile", "id_card", "password", "bank_card", "email", "token", "secret", "authorization", "cookie", "set_cookie", "api_key"]
  .map((n) => n.split("_"));

export const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "time", "level", "msg", "component_id", "component_version", "trace_id", "span_id", "request_id",
]);

export const REDACTED = "[REDACTED]";

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter((w) => w !== "");
}

export function isProtectedKey(key: string): boolean {
  const w = words(key);
  return PROTECTED.some((name) => {
    for (let i = 0; i + name.length <= w.length; i++) {
      const ok = name.every((part, j) => {
        const word = w[i + j]!;
        return word === part || (j === name.length - 1 && word === `${part}s`);
      });
      if (ok) return true;
    }
    return false;
  });
}

function walk(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(walk);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = isProtectedKey(k) ? REDACTED : walk(x);
  return out;
}

/** Redacts every protected key of a record; envelope fields and values are never touched. */
export function redactRecord<T extends Record<string, unknown>>(rec: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = ENVELOPE_FIELDS.has(k) ? v : isProtectedKey(k) ? REDACTED : walk(v);
  return out as T;
}

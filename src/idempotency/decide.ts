// What a key means (P13.1–P13.4, P13.7, P3.7), as pure functions: the caller namespace, the key from the header
// or the body, the key's expiry, and the decision for an incoming command against the stored row.
import { BeError, platformError } from "../errors/beError.js";

export const KEY_TTL_MS = 30 * 24 * 3600 * 1000;

export type CallerRef = { kind: "user"; sub: string } | { kind: "svc"; caller: string } | { kind: "system" };

/** `user:<sub>`, `svc:<be-caller>` or `system` (P13.1). */
export function callerNamespace(c: CallerRef): string {
  return c.kind === "user" ? `user:${c.sub}` : c.kind === "svc" ? `svc:${c.caller}` : "system";
}

/** The key from the Idempotency-Key header or the idempotency_key field; both and different → IDEMPOTENCY_MISMATCH. */
export function resolveKey(header: string | undefined, body: string | undefined): string | undefined {
  const h = header || undefined;
  const b = body || undefined;
  if (h && b && h !== b) throw platformError("IDEMPOTENCY_MISMATCH", undefined, "the Idempotency-Key header and the idempotency_key field differ");
  return h ?? b;
}

/** created_at + 30 days, in the vectors' RFC 3339 form (microseconds kept when present). */
export function expiresAt(createdAt: string): string {
  const m = /\.(\d+)Z$/.exec(createdAt);
  const t = new Date(Date.parse(createdAt) + KEY_TTL_MS).toISOString();
  return m ? t.replace(/\.\d+Z$/, `.${m[1]}Z`) : t.replace(".000Z", "Z");
}

export interface StoredKey {
  command: string;
  target: string;
  /** hex SHA-256 */
  requestHash: string;
  status: "CLAIMED" | "DONE";
  result: unknown;
  expiresAt: Date;
}

export interface IncomingCommand {
  command: string;
  target: string;
  requestHash: string;
}

export type KeyDecision =
  | { outcome: "EXECUTE" }
  | { outcome: "REPLAY"; result: unknown }
  | { outcome: "REJECT"; error: BeError; http: number };

/** The binding is checked first, then the state: a mismatching retry of a running command is a mismatch (P13.2, P13.3). */
export function decideKey(row: StoredKey | undefined, inc: IncomingCommand, now: Date): KeyDecision {
  if (!row || row.expiresAt.getTime() <= now.getTime()) return { outcome: "EXECUTE" };
  if (row.command !== inc.command || row.target !== inc.target || row.requestHash !== inc.requestHash) {
    return { outcome: "REJECT", error: platformError("IDEMPOTENCY_MISMATCH", undefined, "the key was used for another command, target or request"), http: 400 };
  }
  if (row.status === "CLAIMED") return { outcome: "REJECT", error: platformError("IDEMPOTENCY_IN_PROGRESS", undefined, "the command with this key is still running"), http: 409 };
  return { outcome: "REPLAY", result: row.result };
}

/** The key of a REST request (P3.7): the Idempotency-Key header and/or the body's idempotency_key; "" when none. */
export function commandKey(req: { headers: Record<string, unknown>; body?: unknown }): string {
  const h = req.headers["idempotency-key"];
  const b = (req.body as { idempotency_key?: unknown } | undefined)?.idempotency_key;
  return resolveKey(typeof h === "string" ? h : undefined, typeof b === "string" ? b : undefined) ?? "";
}

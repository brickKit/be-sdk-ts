// Command idempotency on besdk_idempotency (P13): the atomic claim of P13 "Claim statement" in the caller's
// transaction, the binding check, replay, and the two-step claim / complete / release. The caller namespace comes
// from the unit of work (callerOf); the request hash is the JCS fingerprint of `request`.
import { callerOf } from "../context.js";
import { platformError } from "../errors/beError.js";
import type { QueryRows } from "../store/types.js";
import { decideKey, type StoredKey } from "./decide.js";
import { fingerprint } from "./jcs.js";

export interface Command {
  /** the Idempotency-Key header or idempotency_key field (resolveKey); "" = run without idempotency */
  key: string;
  /** the permission key or the rpc's full name */
  name: string;
  /** the aggregate ID the command acts on; "" for a create */
  target?: string;
  /** the fingerprint fields: the business fields, never the key or transport headers */
  request: unknown;
}

export interface Prior {
  found: boolean;
  inProgress: boolean;
  result?: unknown;
}

/** The minimum of a Tx this module needs. */
export interface IdemTx {
  query: QueryRows;
}

// an expired row is taken over in place: after 30 days the same key is a new command (P13.7)
const CLAIM = `INSERT INTO besdk_idempotency (caller, idempotency_key, command, target, request_hash, status, expires_at)
  VALUES ($1, $2, $3, $4, $5, 'CLAIMED', now() + interval '30 days')
  ON CONFLICT (caller, idempotency_key) DO UPDATE SET command = EXCLUDED.command, target = EXCLUDED.target,
    request_hash = EXCLUDED.request_hash, status = 'CLAIMED', result = NULL, created_at = now(), updated_at = now(),
    expires_at = EXCLUDED.expires_at
  WHERE besdk_idempotency.expires_at <= now()
  RETURNING status`;
const READ = `SELECT command, target, encode(request_hash, 'hex') AS request_hash, status, result, expires_at
  FROM besdk_idempotency WHERE caller = $1 AND idempotency_key = $2`;
const COMPLETE = `UPDATE besdk_idempotency SET status = 'DONE', result = $3, updated_at = now()
  WHERE caller = $1 AND idempotency_key = $2 AND status = 'CLAIMED' RETURNING 1`;
const RELEASE = `DELETE FROM besdk_idempotency WHERE caller = $1 AND idempotency_key = $2 AND status = 'CLAIMED'`;

interface Bound {
  caller: string;
  key: string;
  name: string;
  target: string;
  hash: Buffer;
}

function bind(c: Command): Bound {
  if (!c.key) throw platformError("INTERNAL", undefined, "an idempotency step needs a key");
  return { caller: callerOf(), key: c.key, name: c.name, target: c.target ?? "", hash: Buffer.from(fingerprint(c.request ?? null)) };
}

/** Reads the row (FOR UPDATE when claiming) and applies the binding and state rules. */
async function prior(tx: IdemTx, b: Bound, forUpdate: boolean): Promise<Prior> {
  const rows = await tx.query(READ + (forUpdate ? " FOR UPDATE" : ""), [b.caller, b.key]);
  const r = rows[0] as { command: string; target: string; request_hash: string; status: "CLAIMED" | "DONE"; result: { body?: unknown } | null; expires_at: Date } | undefined;
  const row: StoredKey | undefined = r && { command: r.command, target: r.target, requestHash: r.request_hash, status: r.status, result: r.result?.body, expiresAt: r.expires_at };
  const d = decideKey(row, { command: b.name, target: b.target, requestHash: b.hash.toString("hex") }, new Date());
  if (d.outcome === "EXECUTE") return { found: false, inProgress: false };
  if (d.outcome === "REPLAY") return { found: true, inProgress: false, result: d.result };
  if (d.error.reason === "IDEMPOTENCY_IN_PROGRESS" && !forUpdate) return { found: true, inProgress: true };
  throw d.error;
}

/** Looks the key up without claiming it; a binding mismatch throws IDEMPOTENCY_MISMATCH. */
export function idemLookup(tx: IdemTx, c: Command): Promise<Prior> {
  return prior(tx, bind(c), false);
}

/**
 * Claims the key: `{found: false}` when this call owns it now; a completed key is `{found: true, result}`;
 * a claimed one throws IDEMPOTENCY_IN_PROGRESS, a mismatch IDEMPOTENCY_MISMATCH. Concurrent claims wait on the
 * row and then see the winner's outcome (P13.6).
 */
export async function idemClaim(tx: IdemTx, c: Command): Promise<Prior> {
  const b = bind(c);
  const inserted = await tx.query(CLAIM, [b.caller, b.key, b.name, b.target, b.hash]);
  if (inserted.length > 0) return { found: false, inProgress: false };
  return prior(tx, b, true);
}

/** Stores the result of a claimed command; a later claim replays it. */
export async function idemComplete(tx: IdemTx, c: Command, result: unknown): Promise<void> {
  const b = bind(c);
  const done = await tx.query(COMPLETE, [b.caller, b.key, JSON.stringify({ body: result ?? null })]);
  if (done.length === 0) throw platformError("INTERNAL", undefined, "idemComplete: the key is not claimed by this command");
}

/** Gives a claimed key up after a step that failed for certain, so the same key may be retried (P13.3). */
export async function idemRelease(tx: IdemTx, c: Command): Promise<void> {
  const b = bind(c);
  await tx.query(RELEASE, [b.caller, b.key]);
}

/**
 * One-step command (P13.3): claim, run and complete in the caller's transaction; a replay never calls `run`.
 * Order (P13.5): validate → access().can on the target → idempotent(…) → state machine → write.
 */
export async function idempotent<T>(tx: IdemTx, c: Command, run: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  if (!c.key) return { result: await run(), replayed: false };
  const p = await idemClaim(tx, c);
  if (p.found) return { result: p.result as T, replayed: true };
  const result = await run();
  await idemComplete(tx, c, result);
  return { result, replayed: false };
}

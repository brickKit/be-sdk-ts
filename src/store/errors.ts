// Driver errors seen by the store: the SQLSTATE of an error (or of its cause), helpers components use instead
// of matching SQLSTATEs themselves (sdk-redesign-apis §2.3), and which failures mean the connection itself is
// gone and must be destroyed rather than returned to the pool.

const SQLSTATE = /^[0-9A-Z]{5}$/;

function ownState(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
}

/** The SQLSTATE of a pg error, or of the pg error a BeError wraps; undefined for anything else. */
export function sqlStateOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const s = ownState(e);
    if (s) return s;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === "23505";
}

export function isLockTimeout(err: unknown): boolean {
  return sqlStateOf(err) === "55P03";
}

const CONNECTION_STATES = new Set(["57P01", "57P02", "57P03", "25P03", "53300"]);

/** True when the connection cannot be reused: network errors, FATAL errors, class 08, server shutdown. */
export function isConnectionError(err: unknown): boolean {
  const state = ownState(err);
  if (state) {
    const severity = (err as { severity?: unknown }).severity;
    return state.startsWith("08") || CONNECTION_STATES.has(state) || severity === "FATAL" || severity === "PANIC";
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return true;
  const msg = String((err as { message?: unknown } | null)?.message ?? "");
  return /Connection terminated|connection error|Client has encountered a connection error|not queryable/i.test(msg);
}

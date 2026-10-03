// How a SQLSTATE leaves a transaction (P10.4; vectors errors/sqlstate).
import { BeError, platformError } from "./beError.js";

export const MAX_TX_ATTEMPTS = 3;

export type SqlContext = "none" | "deadline_exceeded" | "cancelled";

export type Classified = { action: "retry"; baseDelayMs: number } | { action: "fail"; error: BeError };

export function classifySqlState(
  sqlstate: string,
  opts: { attempt: number; context: SqlContext; componentMapping?: BeError; cause?: unknown },
): Classified {
  const fail = (reason: string) => ({ action: "fail" as const, error: platformError(reason, undefined, `SQLSTATE ${sqlstate}`, opts.cause) });
  switch (sqlstate) {
    case "40001":
    case "40P01":
      return opts.attempt < MAX_TX_ATTEMPTS ? { action: "retry", baseDelayMs: 10 * 2 ** (opts.attempt - 1) } : fail("TX_CONFLICT");
    case "55P03":
      return fail("LOCK_TIMEOUT");
    case "57014":
      if (opts.context === "cancelled") return { action: "fail", error: new BeError("CANCELLED", "", { message: "query cancelled", cause: opts.cause }) };
      return fail("STATEMENT_TIMEOUT");
    case "25P04":
      return fail("STATEMENT_TIMEOUT");
    case "53300":
      return fail("DB_TOO_MANY_CONNECTIONS");
    case "BE001":
      return fail("UNIT_SEALED");
    case "23505":
      if (opts.componentMapping) return { action: "fail", error: opts.componentMapping };
      return fail("INTERNAL");
    default:
      return fail("INTERNAL");
  }
}

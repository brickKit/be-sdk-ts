// How a SQLSTATE leaves a transaction (P10.4; vectors errors/sqlstate).
import { BeError, platformError } from "./beError.js";

export const MAX_TX_ATTEMPTS = 3;

export type SqlContext = "none" | "deadline_exceeded" | "cancelled";

export type Classified = { action: "retry"; baseDelayMs: number } | { action: "fail"; error: BeError };

export function classifySqlState(
  sqlstate: string,
  opts: { attempt: number; context: SqlContext; componentMapping?: BeError; cause?: unknown },
): Classified {
  const fail = (reason: string, metadata?: Record<string, string>) => ({ action: "fail" as const, error: platformError(reason, metadata, `SQLSTATE ${sqlstate}`, opts.cause) });
  // the connection or the server is gone (class 08, 57P01–57P03): the database is a dependency that cannot be reached
  if (sqlstate.startsWith("08") || /^57P0[123]$/.test(sqlstate)) return fail("DEPENDENCY_UNAVAILABLE", { dependency: "db" });
  switch (sqlstate) {
    case "40001":
    case "40P01":
      return opts.attempt < MAX_TX_ATTEMPTS ? { action: "retry", baseDelayMs: 10 * 2 ** (opts.attempt - 1) } : fail("TX_CONFLICT");
    case "55P03":
      return fail("LOCK_TIMEOUT");
    case "57014":
      if (opts.context === "cancelled") return fail("REQUEST_CANCELLED");
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

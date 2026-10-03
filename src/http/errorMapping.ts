// How a failed request becomes a problem body (P4, P3.4–P3.6): Fastify's own errors are mapped first; the
// error handler never reads the AsyncLocalStorage (r1-08), only the request's own state.
import { platformError, isBeError } from "../errors/beError.js";
import { fromStatus } from "../grpc/errors.js";

/** Fastify errors that are not BeErrors, mapped to protocol errors; anything else is returned unchanged. */
export function mapFrameworkError(err: unknown): unknown {
  const e = err as { code?: string; statusCode?: number; validation?: unknown; message?: string };
  switch (e?.code) {
    case "FST_ERR_HANDLER_TIMEOUT":
      return platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the route's deadline passed");
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return platformError("BODY_TOO_LARGE", undefined, e.message);
  }
  if (e?.validation || (typeof e?.code === "string" && e.code.startsWith("FST_ERR_CTP_")) || (e?.statusCode === 400 && !isBeError(err))) {
    return platformError("REQUEST_INVALID", undefined, e.message);
  }
  // a dependency's gRPC status error that component code let through: relay its code, reason and domain (P4.2)
  return fromStatus(err) ?? err;
}

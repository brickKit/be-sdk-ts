// The gRPC half of P4.2: a BeError leaves as a status code, the default-language detail as the message, and
// `grpc-status-details-bin` with google.rpc.Status{code, message, details: [ErrorInfo, BadRequest?, RetryInfo?]};
// a status that comes back is restored as the same BeError, so a REST answer relays the dependency's reason.
// The detail is rendered exactly as the REST problem body renders it (problemBody), hidden codes included (P4.3).
import { Metadata, type StatusObject } from "@grpc/grpc-js";
import { BeError, isBeError } from "../errors/beError.js";
import type { ErrorCatalog } from "../errors/catalog.js";
import { CODES, codeName } from "../errors/codes.js";
import { problemBody } from "../errors/problem.js";
import { decodeStatus, encodeStatus, type StatusDetails } from "./statusDetails.js";

export const STATUS_DETAILS_KEY = "grpc-status-details-bin";

export interface RenderOptions {
  memberId: string;
  locale: string;
  catalog: ErrorCatalog;
  /** the rpc path, the problem's `instance` */
  path: string;
  requestId: string;
  traceId: string;
}

/** The error as the log records it: a BeError with its domain, or INTERNAL carrying the original as cause. */
export function loggedError(err: unknown, memberId: string): BeError {
  if (isBeError(err) && err.reason !== "") return err.withDomain(memberId);
  const message = String((err as Error)?.message ?? err);
  return new BeError("INTERNAL", "INTERNAL", { domain: "be", message, cause: err });
}

/**
 * The status a server answers. A reasonless BeError (a dependency's status that carried no details) is foreign
 * to this component and leaves as INTERNAL, like any other error without an identity.
 */
export function toStatus(err: unknown, o: RenderOptions): StatusObject {
  const shown = isBeError(err) && err.reason !== "" ? err : new BeError("INTERNAL", "INTERNAL", { domain: "be" });
  let body: Record<string, any>;
  try {
    body = problemBody(shown, { path: o.path, requestId: o.requestId, traceId: o.traceId }, { locale: o.locale, componentId: o.memberId, catalog: o.catalog }).body;
  } catch {
    // a malformed error (non-string metadata) must not escape as a second failure
    body = problemBody(new BeError("INTERNAL", "INTERNAL", { domain: "be" }), { path: o.path, requestId: o.requestId, traceId: o.traceId }, { locale: o.locale, catalog: o.catalog }).body;
  }
  const hidden = body.reason === "INTERNAL" && body.domain === "be";
  const details: StatusDetails = {
    code: CODES[body.code as keyof typeof CODES],
    message: String(body.detail),
    errorInfo: { reason: body.reason, domain: body.domain, metadata: body.metadata },
  };
  if (!hidden && shown.violations.length > 0) {
    details.badRequest = shown.violations.map((v) => ({ field: v.field, reason: v.reason, description: v.description ?? "" }));
  }
  if (!hidden && shown.retryAfterMs !== undefined) details.retryDelayMs = shown.retryAfterMs;
  return statusOf(details);
}

/** A status object, trailers included, for a refusal the runtime produces itself (client or server side). */
export function statusOf(details: StatusDetails): StatusObject {
  const metadata = new Metadata();
  metadata.set(STATUS_DETAILS_KEY, Buffer.from(encodeStatus(details)));
  return { code: details.code, details: details.message, metadata };
}

/** The client-side status of an error the runtime raises before sending (deadline budget, bulkhead, guard). */
export function localStatus(err: BeError): StatusObject {
  const d: StatusDetails = {
    code: CODES[err.code],
    message: err.message,
    errorInfo: { reason: err.reason, domain: err.domain ?? "be", metadata: err.metadata },
  };
  if (err.retryAfterMs !== undefined) d.retryDelayMs = err.retryAfterMs;
  return statusOf(d);
}

/**
 * Restores a dependency's error: same code, reason, domain, metadata, violations and retry delay, the status
 * message as the detail. A status without usable details (a transport failure, a foreign server) keeps its code
 * with `reason: ""` and no domain, as restoreHttp does for a REST answer without a problem body. Returns
 * undefined for anything that is not a gRPC status error.
 */
export function fromStatus(err: unknown): BeError | undefined {
  if (isBeError(err)) return err;
  const s = err as Partial<StatusObject> | null | undefined;
  if (typeof s?.code !== "number" || s.code === 0) return undefined;
  const message = typeof s.details === "string" ? s.details : "";
  const raw = s.metadata instanceof Metadata ? s.metadata.get(STATUS_DETAILS_KEY)[0] : undefined;
  let d: StatusDetails | undefined;
  try {
    d = raw instanceof Buffer ? decodeStatus(raw) : undefined;
  } catch {
    d = undefined;
  }
  const code = codeName(s.code);
  const info = d?.errorInfo;
  if (!d || !info || info.reason === "") {
    return new BeError(code, "", { message: message || code, cause: err });
  }
  return new BeError(codeName(d.code === 0 ? s.code : d.code), info.reason, {
    domain: info.domain || undefined,
    metadata: info.metadata,
    message: d.message || message,
    violations: (d.badRequest ?? []).map((v) => ({ field: v.field, reason: v.reason, ...(v.description ? { description: v.description } : {}) })),
    retryAfterMs: d.retryDelayMs,
    cause: err,
  });
}

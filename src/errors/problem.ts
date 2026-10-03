// RFC 9457 problem+json carrying AIP-193 members (P4.1, P4.3); restoring a dependency's REST error (P8.2);
// Retry-After (P4); reason-name rules (P4.4, P4.7). Vectors errors/problem, errors/codes.
import { BeError } from "./beError.js";
import { HIDDEN_CODES, codeFromHttpStatus, httpStatus, isCode } from "./codes.js";
import { beCatalog, type ErrorCatalog } from "./catalog.js";
import { SpecError } from "./specError.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export interface ProblemRequest {
  path: string;
  requestId: string;
  traceId: string;
}

export interface ProblemOptions {
  /** DEFAULT_LOCALE */
  locale: string;
  /** the domain of an error raised without one: the member's component ID */
  componentId?: string;
  catalog?: ErrorCatalog;
}

export interface Problem {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

const GENERIC_DETAIL = { zh: "系统出错了。反馈时请提供 trace ID。", en: "Something went wrong. Quote the trace ID when reporting it." };

/** The error as the caller sees it: hidden codes, foreign errors and errors without a domain become INTERNAL. */
export function publicError(err: unknown, componentId?: string): BeError {
  if (!(err instanceof BeError)) return new BeError("INTERNAL", "INTERNAL", { domain: "be" });
  const domain = err.domain ?? componentId;
  if (HIDDEN_CODES.has(err.code) || !domain) return new BeError(HIDDEN_CODES.has(err.code) ? err.code : "INTERNAL", "INTERNAL", { domain: "be" });
  return err.withDomain(domain);
}

export function problemBody(err: unknown, req: ProblemRequest, opts: ProblemOptions): Problem {
  const e = publicError(err, opts.componentId);
  for (const [k, v] of Object.entries(e.metadata)) {
    if (typeof v !== "string") throw new SpecError("METADATA_NOT_STRING", `metadata ${k} is not a string`);
  }
  const domain = e.domain ?? "be";
  const status = httpStatus(e.code, e.reason, domain);
  const text = (opts.catalog ?? beCatalog()).render(domain, e.reason, opts.locale, e.metadata);
  const hidden = e.reason === "INTERNAL" && domain === "be";
  const body: Record<string, any> = {
    type: `urn:be:${domain}:${e.reason}`,
    title: text.title ?? e.reason,
    status,
    code: e.code,
    reason: e.reason,
    domain,
    detail: hidden ? GENERIC_DETAIL[opts.locale.toLowerCase().startsWith("zh") ? "zh" : "en"] : (text.detail ?? (e.message !== e.reason ? e.message : e.reason)),
    metadata: { ...e.metadata },
    instance: req.path,
    request_id: req.requestId,
    trace_id: req.traceId,
  };
  if (e.violations.length > 0) body.violations = e.violations;
  const headers: Record<string, string> = {};
  const ra = retryAfterHeader(e.code, e.retryAfterMs);
  if (ra !== null) headers["retry-after"] = ra;
  return { status, contentType: PROBLEM_CONTENT_TYPE, headers, body };
}

/** Retry-After only with 429 / 503 and a delay; whole seconds rounded up. */
export function retryAfterHeader(code: string, delayMs: number | undefined | null): string | null {
  if (delayMs === undefined || delayMs === null) return null;
  const status = httpStatus(code);
  if (status !== 429 && status !== 503) return null;
  return String(Math.ceil(delayMs / 1000));
}

/** Restores a dependency's REST answer as the same code, reason and domain (P8.2). */
export function restoreHttp(status: number, problem: Record<string, any> | null | undefined): BeError & { reason: string | null } {
  const p = problem ?? {};
  if (isCode(p.code) && typeof p.reason === "string" && typeof p.domain === "string") {
    const meta = typeof p.metadata === "object" && p.metadata !== null ? (p.metadata as Record<string, string>) : undefined;
    return withStatus(new BeError(p.code, p.reason, { domain: p.domain, metadata: meta, message: p.detail, violations: p.violations }), status);
  }
  const code = isCode(p.code) ? p.code : codeFromHttpStatus(status);
  return withStatus(Object.assign(new BeError(code, "", { message: `HTTP ${status}` }), { reason: null, domain: null }), status);
}

function withStatus<T extends BeError>(e: T, status: number): T & { reason: string | null } {
  return Object.assign(e, { httpStatus: status }) as T & { reason: string | null };
}

const REASON_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

export function validateReasonName(reason: string, domain: string): void {
  if (!REASON_NAME.test(reason)) throw new SpecError("REASON_NAME_INVALID", `reason ${reason} is not UPPER_SNAKE`);
  if (domain !== "be" && beCatalog().get("be", reason)) throw new SpecError("REASON_RESERVED", `${reason} is a reserved reason of domain be`);
}

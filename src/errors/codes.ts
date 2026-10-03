// gRPC canonical codes, their HTTP statuses and log levels (P4.2, P4.6; vectors errors/codes, levels).
import { SpecError } from "./specError.js";

export const CODES = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4, NOT_FOUND: 5,
  ALREADY_EXISTS: 6, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9, ABORTED: 10,
  OUT_OF_RANGE: 11, UNIMPLEMENTED: 12, INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
} as const;
export type GrpcCode = keyof typeof CODES;

const HTTP: Record<GrpcCode, number> = {
  OK: 200, CANCELLED: 499, UNKNOWN: 500, INVALID_ARGUMENT: 400, DEADLINE_EXCEEDED: 504, NOT_FOUND: 404,
  ALREADY_EXISTS: 409, PERMISSION_DENIED: 403, RESOURCE_EXHAUSTED: 429, FAILED_PRECONDITION: 400, ABORTED: 409,
  OUT_OF_RANGE: 400, UNIMPLEMENTED: 501, INTERNAL: 500, UNAVAILABLE: 503, DATA_LOSS: 500, UNAUTHENTICATED: 401,
};

export function isCode(name: unknown): name is GrpcCode {
  return typeof name === "string" && Object.hasOwn(CODES, name);
}

export function codeNumber(name: string): number {
  if (!isCode(name)) throw new SpecError("CODE_UNKNOWN", `not a canonical gRPC code: ${name}`);
  return CODES[name];
}

export function codeName(n: number): GrpcCode {
  const hit = (Object.keys(CODES) as GrpcCode[]).find((k) => CODES[k] === n);
  return hit ?? "UNKNOWN";
}

/** HTTP status of an error; the one exception is be/BODY_TOO_LARGE, answered 413. */
export function httpStatus(code: string, reason?: string | null, domain?: string | null): number {
  codeNumber(code);
  if (reason === "BODY_TOO_LARGE" && domain === "be") return 413;
  return HTTP[code as GrpcCode];
}

/** Code of a REST answer that carried no usable problem body (P8.2). */
export function codeFromHttpStatus(status: number): GrpcCode {
  const table: Record<number, GrpcCode> = {
    400: "INVALID_ARGUMENT", 413: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED",
    404: "NOT_FOUND", 409: "ABORTED", 429: "RESOURCE_EXHAUSTED", 499: "CANCELLED", 501: "UNIMPLEMENTED",
    502: "UNAVAILABLE", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED",
  };
  return table[status] ?? (status >= 400 && status < 500 ? "FAILED_PRECONDITION" : "UNKNOWN");
}

export type LogLevel = "error" | "warn" | "info" | "none";

/** P4.6: the runtime decides the level of an error from its code. */
export function logLevel(code: string): LogLevel {
  codeNumber(code);
  if (code === "INTERNAL" || code === "UNKNOWN" || code === "DATA_LOSS") return "error";
  if (code === "UNAVAILABLE" || code === "DEADLINE_EXCEEDED") return "warn";
  if (code === "OK" || code === "CANCELLED") return "none";
  return "info";
}

export const HIDDEN_CODES: ReadonlySet<string> = new Set(["INTERNAL", "UNKNOWN", "DATA_LOSS"]);

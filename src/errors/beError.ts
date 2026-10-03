// The one error type of the runtime (P4): a gRPC code, a machine reason and its domain, string metadata,
// optional field violations and retry delay. Component code raises it with beError(); the HTTP error handler,
// the gRPC interceptor and the GraphQL mapping render it.
import { isCode, type GrpcCode } from "./codes.js";
import { beCatalog } from "./catalog.js";
import { SpecError } from "./specError.js";

export interface Violation {
  field: string;
  reason: string;
  description?: string;
}

export interface BeErrorOptions {
  /** the error's domain; absent = the raising component's ID, filled when the error is rendered */
  domain?: string;
  metadata?: Record<string, string>;
  /** text for the log and, for caller errors without a catalogue entry, the detail */
  message?: string;
  violations?: Violation[];
  retryAfterMs?: number;
  cause?: unknown;
}

export class BeError extends Error {
  readonly code: GrpcCode;
  readonly reason: string;
  readonly domain: string | undefined;
  readonly metadata: Record<string, string>;
  readonly violations: Violation[];
  readonly retryAfterMs: number | undefined;

  constructor(code: string, reason: string, opts: BeErrorOptions = {}) {
    super(opts.message ?? reason, opts.cause === undefined ? undefined : { cause: opts.cause });
    if (!isCode(code)) throw new SpecError("CODE_UNKNOWN", `not a canonical gRPC code: ${code}`);
    this.name = "BeError";
    this.code = code;
    this.reason = reason;
    this.domain = opts.domain;
    this.metadata = opts.metadata ?? {};
    this.violations = opts.violations ?? [];
    this.retryAfterMs = opts.retryAfterMs;
  }

  withDomain(domain: string): BeError {
    if (this.domain !== undefined) return this;
    return new BeError(this.code, this.reason, { ...this.options(), domain });
  }

  private options(): BeErrorOptions {
    return { metadata: this.metadata, message: this.message, violations: this.violations, retryAfterMs: this.retryAfterMs, cause: this.cause };
  }
}

/** A component's own error (sdk-redesign-apis §4 `beError`); its domain is the component's ID. */
export function beError(code: string, reason: string, metadata?: Record<string, string>, message?: string): BeError {
  return new BeError(code, reason, { metadata, message });
}

/** A reserved reason of domain `be` (schemas/errors-be.yaml); its code comes from the catalogue. */
export function platformError(reason: string, metadata?: Record<string, string>, message?: string, cause?: unknown): BeError {
  const entry = beCatalog().get("be", reason);
  if (!entry) throw new SpecError("REASON_UNKNOWN", `not a reserved reason of domain be: ${reason}`);
  return new BeError(entry.code, reason, { domain: "be", metadata, message, cause });
}

export function isBeError(e: unknown): e is BeError {
  return e instanceof BeError;
}

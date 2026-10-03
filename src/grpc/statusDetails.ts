// google.rpc.Status and the error details P4.2 uses (ErrorInfo, BadRequest, RetryInfo, PreconditionFailure,
// ResourceInfo), carried in the `grpc-status-details-bin` trailer. Hand-written because the runtime needs only
// these six messages: a generated copy would pull a protobuf runtime into the SDK's dependencies and a second
// copy of google/rpc into every component. Field numbers are googleapis' google/rpc/status.proto and
// google/rpc/error_details.proto; test/unit/grpc/statusDetails.test.ts checks them against generated code.

export interface ErrorInfo {
  reason: string;
  domain: string;
  metadata: Record<string, string>;
}

export interface FieldViolation {
  field: string;
  description: string;
  reason: string;
}

export interface PreconditionViolation {
  type: string;
  subject: string;
  description: string;
}

export interface ResourceInfo {
  resourceType: string;
  resourceName: string;
  owner: string;
  description: string;
}

export interface AnyDetail {
  typeUrl: string;
  value: Uint8Array;
}

export interface StatusDetails {
  code: number;
  message: string;
  errorInfo?: ErrorInfo;
  badRequest?: FieldViolation[];
  retryDelayMs?: number;
  preconditionFailure?: PreconditionViolation[];
  resourceInfo?: ResourceInfo;
  /** details of other types, kept as they came */
  unknown?: AnyDetail[];
}

const PREFIX = "type.googleapis.com/google.rpc.";
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

// ---- writing ---------------------------------------------------------------------------------------------

class Writer {
  private readonly parts: number[] = [];

  varint(v: number | bigint): this {
    let n = BigInt.asUintN(64, BigInt(v));
    while (n > 0x7fn) {
      this.parts.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.parts.push(Number(n));
    return this;
  }

  /** proto3: a field with its default value is not written */
  int(field: number, v: number): this {
    return v === 0 ? this : this.varint((field << 3) | 0).varint(v);
  }

  bytes(field: number, b: Uint8Array): this {
    this.varint((field << 3) | 2).varint(b.length);
    for (const x of b) this.parts.push(x);
    return this;
  }

  str(field: number, s: string): this {
    return s === "" ? this : this.bytes(field, utf8.encode(s));
  }

  /** an embedded message is written even when empty: its presence matters (a repeated element, an Any) */
  msg(field: number, w: Writer): this {
    return this.bytes(field, w.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function any(name: string, w: Writer): Writer {
  return new Writer().str(1, PREFIX + name).msg(2, w);
}

function errorInfo(e: ErrorInfo): Writer {
  const w = new Writer().str(1, e.reason).str(2, e.domain);
  for (const [k, v] of Object.entries(e.metadata)) w.msg(3, new Writer().str(1, k).str(2, v));
  return w;
}

export function encodeStatus(s: StatusDetails): Uint8Array {
  const w = new Writer().int(1, s.code).str(2, s.message);
  if (s.errorInfo) w.msg(3, any("ErrorInfo", errorInfo(s.errorInfo)));
  if (s.badRequest?.length) {
    const br = new Writer();
    for (const v of s.badRequest) br.msg(1, new Writer().str(1, v.field).str(2, v.description).str(3, v.reason));
    w.msg(3, any("BadRequest", br));
  }
  if (s.retryDelayMs !== undefined) {
    const ms = Math.max(0, Math.round(s.retryDelayMs));
    const duration = new Writer().int(1, Math.floor(ms / 1000)).int(2, (ms % 1000) * 1_000_000);
    w.msg(3, any("RetryInfo", new Writer().msg(1, duration)));
  }
  if (s.preconditionFailure?.length) {
    const pf = new Writer();
    for (const v of s.preconditionFailure) pf.msg(1, new Writer().str(1, v.type).str(2, v.subject).str(3, v.description));
    w.msg(3, any("PreconditionFailure", pf));
  }
  if (s.resourceInfo) {
    const r = s.resourceInfo;
    w.msg(3, any("ResourceInfo", new Writer().str(1, r.resourceType).str(2, r.resourceName).str(3, r.owner).str(4, r.description)));
  }
  for (const u of s.unknown ?? []) w.msg(3, new Writer().str(1, u.typeUrl).bytes(2, u.value));
  return w.finish();
}

// ---- reading ---------------------------------------------------------------------------------------------

type Field = { n: number; v: bigint | Uint8Array };

/** Every field of one message, in order; unknown wire types and truncation throw. */
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let r = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (i >= b.length || shift > 63n) throw new Error("malformed varint");
      const x = b[i++]!;
      r |= BigInt(x & 0x7f) << shift;
      if (x < 0x80) return r;
    }
  };
  const take = (len: number): Uint8Array => {
    if (len < 0 || i + len > b.length) throw new Error("truncated field");
    const s = b.slice(i, i + len);
    i += len;
    return s;
  };
  while (i < b.length) {
    const tag = Number(varint());
    const n = tag >>> 3;
    switch (tag & 7) {
      case 0: out.push({ n, v: varint() }); break;
      case 1: out.push({ n, v: take(8) }); break;
      case 2: out.push({ n, v: take(Number(varint())) }); break;
      case 5: out.push({ n, v: take(4) }); break;
      default: throw new Error(`unsupported wire type ${tag & 7}`);
    }
  }
  return out;
}

const str = (f: Field): string => (f.v instanceof Uint8Array ? fromUtf8.decode(f.v) : "");
const bin = (f: Field): Uint8Array => (f.v instanceof Uint8Array ? f.v : new Uint8Array());
const num = (f: Field): number => (typeof f.v === "bigint" ? Number(BigInt.asIntN(64, f.v)) : 0);

function strings<K extends string>(b: Uint8Array, names: Record<number, K>): Record<K, string> {
  const o = Object.fromEntries(Object.values<K>(names).map((k) => [k, ""])) as Record<K, string>;
  for (const f of fields(b)) if (names[f.n] !== undefined) o[names[f.n]!] = str(f);
  return o;
}

function readErrorInfo(b: Uint8Array): ErrorInfo {
  const e: ErrorInfo = { reason: "", domain: "", metadata: {} };
  for (const f of fields(b)) {
    if (f.n === 1) e.reason = str(f);
    else if (f.n === 2) e.domain = str(f);
    else if (f.n === 3) {
      const kv = strings(bin(f), { 1: "k", 2: "v" });
      e.metadata[kv.k] = kv.v;
    }
  }
  return e;
}

function readRepeated<T>(b: Uint8Array, read: (x: Uint8Array) => T): T[] {
  return fields(b).filter((f) => f.n === 1).map((f) => read(bin(f)));
}

function readRetryDelayMs(b: Uint8Array): number {
  let seconds = 0;
  let nanos = 0;
  for (const f of fields(b)) {
    if (f.n !== 1) continue;
    for (const d of fields(bin(f))) {
      if (d.n === 1) seconds = num(d);
      else if (d.n === 2) nanos = num(d);
    }
  }
  return seconds * 1000 + Math.round(nanos / 1_000_000);
}

function readDetail(out: StatusDetails, typeUrl: string, value: Uint8Array): void {
  switch (typeUrl.startsWith(PREFIX) ? typeUrl.slice(PREFIX.length) : "") {
    case "ErrorInfo": out.errorInfo = readErrorInfo(value); return;
    case "BadRequest": out.badRequest = readRepeated(value, (x) => strings(x, { 1: "field", 2: "description", 3: "reason" })); return;
    case "RetryInfo": out.retryDelayMs = readRetryDelayMs(value); return;
    case "PreconditionFailure": out.preconditionFailure = readRepeated(value, (x) => strings(x, { 1: "type", 2: "subject", 3: "description" })); return;
    case "ResourceInfo":
      out.resourceInfo = strings(value, { 1: "resourceType", 2: "resourceName", 3: "owner", 4: "description" });
      return;
    default: out.unknown!.push({ typeUrl, value });
  }
}

export function decodeStatus(b: Uint8Array): StatusDetails {
  const out: StatusDetails = { code: 0, message: "", unknown: [] };
  for (const f of fields(b)) {
    if (f.n === 1) out.code = num(f);
    else if (f.n === 2) out.message = str(f);
    else if (f.n === 3) {
      const a: AnyDetail = { typeUrl: "", value: new Uint8Array() };
      for (const x of fields(bin(f))) {
        if (x.n === 1) a.typeUrl = str(x);
        else if (x.n === 2) a.value = bin(x);
      }
      readDetail(out, a.typeUrl, a.value);
    }
  }
  return out;
}

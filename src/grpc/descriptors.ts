// What the runtime reads from a contract's generated code (r1-03, r1-03b): ts-proto with `outputSchema=true`
// exports `protoMetadata` per proto file, carrying the file descriptor (methods, idempotency levels, message
// fields) and, separately, the custom options by their short name (`max_items`). The types below are the
// structural subset the runtime needs, so any ts-proto version's `ProtoMetadata` is assignable without the SDK
// depending on ts-proto-descriptors.

export interface FieldDescriptorLike {
  name: string;
  /** 3 = repeated */
  label: number;
  /** 11 = message */
  type: number;
  typeName: string;
  /** the TS property name ts-proto uses (`widget_ids` → `widgetIds`) */
  jsonName: string;
}

export interface MessageDescriptorLike {
  name: string;
  field: FieldDescriptorLike[];
  nestedType: MessageDescriptorLike[];
  options?: { mapEntry?: boolean } | undefined;
}

export interface MethodDescriptorLike {
  name: string;
  inputType: string;
  /** 0 unknown, 1 NO_SIDE_EFFECTS, 2 IDEMPOTENT */
  options?: { idempotencyLevel?: number } | undefined;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface MessageOptionsLike {
  fields?: { [field: string]: { [option: string]: unknown } };
  nested?: { [message: string]: MessageOptionsLike };
}

export interface ProtoMetadataLike {
  fileDescriptor: {
    package: string;
    messageType: MessageDescriptorLike[];
    service: { name: string; method: MethodDescriptorLike[] }[];
  };
  dependencies?: ProtoMetadataLike[];
  options?: { messages?: { [message: string]: MessageOptionsLike } };
}

export interface MethodInfo {
  /** `/pkg.Service/Method`, the grpc-js path */
  path: string;
  /** `pkg.Service` */
  service: string;
  method: string;
  /** fully qualified input type, `.pkg.Message` */
  inputType: string;
  idempotencyLevel: number;
  streaming: boolean;
}

export interface MessageEntry {
  desc: MessageDescriptorLike;
  opts: MessageOptionsLike | undefined;
}

/** Every rpc of a proto file, keyed by its grpc-js path. */
export function methodsOf(meta: ProtoMetadataLike): Map<string, MethodInfo> {
  const out = new Map<string, MethodInfo>();
  const pkg = meta.fileDescriptor.package;
  for (const svc of meta.fileDescriptor.service) {
    const service = pkg ? `${pkg}.${svc.name}` : svc.name;
    for (const m of svc.method) {
      out.set(`/${service}/${m.name}`, {
        path: `/${service}/${m.name}`, service, method: m.name, inputType: m.inputType,
        idempotencyLevel: m.options?.idempotencyLevel ?? 0, streaming: m.clientStreaming || m.serverStreaming,
      });
    }
  }
  return out;
}

/** Every message type reachable from a proto file and its imports, keyed `.pkg.Outer.Inner`. */
export function messagesOf(meta: ProtoMetadataLike, into = new Map<string, MessageEntry>(), seen = new Set<ProtoMetadataLike>()): Map<string, MessageEntry> {
  if (seen.has(meta)) return into;
  seen.add(meta);
  const pkg = meta.fileDescriptor.package;
  const walk = (prefix: string, desc: MessageDescriptorLike, opts: MessageOptionsLike | undefined) => {
    const fq = `${prefix}.${desc.name}`;
    into.set(fq, { desc, opts });
    for (const n of desc.nestedType) walk(fq, n, opts?.nested?.[n.name]);
  };
  for (const m of meta.fileDescriptor.messageType) walk(pkg ? `.${pkg}` : "", m, meta.options?.messages?.[m.name]);
  for (const d of meta.dependencies ?? []) messagesOf(d, into, seen);
  return into;
}

const RETRY_POLICY = {
  maxAttempts: 3,
  initialBackoff: "0.05s",
  maxBackoff: "0.5s",
  backoffMultiplier: 2,
  retryableStatusCodes: ["UNAVAILABLE"],
};

export interface ServiceConfig {
  methodConfig: { name: { service: string; method: string }[]; retryPolicy: typeof RETRY_POLICY }[];
  retryThrottling: { maxTokens: number; tokenRatio: number };
}

/**
 * The service config of P7.8, identical in every language: NO_SIDE_EFFECTS and IDEMPOTENT methods are retried
 * on UNAVAILABLE, 3 attempts in total; every other method gets only gRPC's transparent retry. grpc-js keeps the
 * retryThrottling budget per process and canonical target, shared by every channel to that target, and does not
 * refill it on re-resolution (r1-03): in a TS shell, members calling one dependency share one budget.
 */
export function serviceConfig(schemas: Iterable<ProtoMetadataLike>): ServiceConfig {
  const names = new Map<string, { service: string; method: string }>();
  for (const s of schemas) {
    for (const m of methodsOf(s).values()) {
      if (m.idempotencyLevel === 1 || m.idempotencyLevel === 2) names.set(m.path, { service: m.service, method: m.method });
    }
  }
  const sorted = [...names.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, n]) => n);
  return {
    methodConfig: sorted.length ? [{ name: sorted, retryPolicy: RETRY_POLICY }] : [],
    retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
  };
}

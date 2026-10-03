// The member's gRPC server (P7.3–P7.5, P7.10, P7.11): one grpc-js server per member on its own port, the fixed
// server options, and a registrar that wraps every unary handler in the runtime's call chain (serverCall.ts).
//
// P7.5 keepalive enforcement (MinTime 20 s, no pings without calls) cannot be configured: grpc-js has no server
// keepalive enforcement (r1-03 R6, `grpc.http2.min_ping_interval_without_data_ms` is ignored). The TS runtime
// relies on clients keeping P7.6, and the README states it.
import { Server, ServerCredentials, type ServerOptions, type ServiceDefinition, type UntypedServiceImplementation } from "@grpc/grpc-js";
import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { ErrorCatalog } from "../errors/catalog.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { batchCheck } from "./batchLimits.js";
import { methodsOf, type ProtoMetadataLike } from "./descriptors.js";
import { DEADLINE_FLOOR_MS, wrapUnary, type UnaryHandler } from "./serverCall.js";

export const MAX_RECEIVE_BYTES = 4 << 20;
export const MAX_CONNECTION_AGE_GRACE_MS = 30_000;

export interface GrpcServerDeps {
  memberId: string;
  /** the domain of the component's own errors; default memberId (P4.1) */
  errorDomain?: string;
  /** DEFAULT_LOCALE: the language of the status message (the problem's `detail`) */
  locale: string;
  catalog: ErrorCatalog;
  logger: Logger;
  metrics: MemberRegistry;
  /** the member's own tracer, never the global provider */
  tracer: Tracer;
  /** GRPC_MAX_CONNECTION_AGE in ms (default 5 min); GOAWAY after it, so kube-proxy rebalances (P7.5) */
  maxConnectionAgeMs: number;
  /** test seam: the deadline of a call without grpc-timeout, 10 s (P7.4) */
  deadlineFloorMs?: number;
}

export interface ServiceOptions {
  /** the contract's generated `protoMetadata` (ts-proto `outputSchema=true`): methods and batch limits */
  schema: ProtoMetadataLike;
  /**
   * proto method names of user-facing rpcs kept in the contract (`["ApproveWidget"]`): they answer
   * UNAUTHENTICATED from the runtime and the component's handler never runs (P7.3)
   */
  userFacing?: readonly string[];
}

/** What `Module.grpc` receives: grpc-js's `addService` with the contract's schema. */
export interface GrpcRegistrar {
  addService(def: ServiceDefinition, impl: object, opts: ServiceOptions): void;
}

export interface GrpcServer extends GrpcRegistrar {
  readonly server: Server;
  /** number of services registered: the runtime starts no server for a member that registers none */
  readonly serviceCount: number;
  /** binds `[::]:port` (dual stack), `0.0.0.0:port` where IPv6 is unavailable; returns the bound port */
  listen(port: number): Promise<number>;
  /** stops accepting calls, lets admitted calls finish for up to `graceMs`, then cuts what is left */
  close(graceMs?: number): Promise<void>;
}

export function buildGrpcServer(d: GrpcServerDeps): GrpcServer {
  const options: ServerOptions = {
    "grpc.max_receive_message_length": MAX_RECEIVE_BYTES,
    "grpc.max_connection_age_ms": d.maxConnectionAgeMs,
    // must stay longer than the longest deadline the server accepts (the 10 s floor), so GOAWAY never cuts a call
    "grpc.max_connection_age_grace_ms": MAX_CONNECTION_AGE_GRACE_MS,
  };
  const server = new Server(options);
  const deps = { ...d, deadlineFloorMs: d.deadlineFloorMs ?? DEADLINE_FLOOR_MS };
  let count = 0;
  return {
    server,
    get serviceCount() {
      return count;
    },
    addService(def, impl, opts) {
      server.addService(def, wrapService(deps, def, impl, opts));
      count++;
    },
    listen: (port) => listenDualStack(server, port),
    close: (graceMs = MAX_CONNECTION_AGE_GRACE_MS) => closeServer(server, graceMs),
  };
}

/** Checks the whole service at registration, so a contract mistake fails at start, not on the first call. */
function wrapService(d: Parameters<typeof wrapUnary>[0], def: ServiceDefinition, impl: object, opts: ServiceOptions): UntypedServiceImplementation {
  const methods = methodsOf(opts.schema);
  const userFacing = new Set(opts.userFacing ?? []);
  const wrapped: UntypedServiceImplementation = {};
  for (const [key, m] of Object.entries(def)) {
    if (m.requestStream || m.responseStream) throw new Error(`streaming rpc ${m.path} is not allowed (P7.11)`);
    const info = methods.get(m.path);
    if (!info) throw new Error(`rpc ${m.path} is not in the schema passed with its service: pass that proto file's protoMetadata`);
    userFacing.delete(info.method);
    const handler = (impl as Record<string, unknown>)[key];
    const isUserFacing = (opts.userFacing ?? []).includes(info.method);
    if (typeof handler !== "function" && !isUserFacing) continue; // grpc-js answers UNIMPLEMENTED
    const run: UnaryHandler = typeof handler === "function" ? (handler as UnaryHandler) : () => Promise.resolve(undefined);
    wrapped[key] = wrapUnary(d, { info, batch: batchCheck(opts.schema, info.inputType), userFacing: isUserFacing }, run, impl);
  }
  if (userFacing.size > 0) throw new Error(`userFacing names no rpc of this service: ${[...userFacing].join(", ")}`);
  return wrapped;
}

function bind(server: Server, address: string): Promise<number> {
  return new Promise((resolve, reject) => server.bindAsync(address, ServerCredentials.createInsecure(), (e, port) => (e ? reject(e) : resolve(port))));
}

async function listenDualStack(server: Server, port: number): Promise<number> {
  try {
    return await bind(server, `[::]:${port}`);
  } catch {
    return bind(server, `0.0.0.0:${port}`);
  }
}

function closeServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => {
      server.forceShutdown();
      resolve();
    }, graceMs);
    server.tryShutdown(() => {
      clearTimeout(cut);
      resolve();
    });
  });
}

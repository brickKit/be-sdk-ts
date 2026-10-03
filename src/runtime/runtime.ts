// What a module's `create` receives (sdk-redesign-apis §4 Runtime): the member's identity, configuration,
// logger, tracer, meter and registry, and the runtime-owned clients. Built per member; never a process global,
// so a shell can host several.
import type { Meter, Tracer } from "@opentelemetry/api";
import type { Registry } from "@prometheus-io/client";
import type { ChannelInterface } from "@grpc/grpc-js";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { DependencyAbsentError } from "../errors/dependencyAbsent.js";
import { platformError } from "../errors/beError.js";
import type { ClientCtor, FamilyGrpcKey, GrpcClients } from "../grpc/clients.js";
import type { ProtoMetadataLike } from "../grpc/descriptors.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { ExternalHttp, UserHttp } from "../outbound/http.js";
import type { Store } from "../store/store.js";

export interface Clock {
  now(): Date;
}

export interface RuntimeInit {
  id: string;
  version: string;
  config: Config;
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
  metrics: MemberRegistry;
  grpc: GrpcClients;
  /** undefined when the component declares no PG_SCHEMA */
  store?: () => Store;
}

export class Runtime {
  readonly id: string;
  readonly version: string;
  readonly config: Config;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly registry: Registry;
  readonly clock: Clock = { now: () => new Date() };
  private readonly i: RuntimeInit;
  private readonly users = new Map<string, UserHttp>();
  private readonly externals = new Map<string, ExternalHttp>();

  constructor(i: RuntimeInit) {
    this.i = i;
    this.id = i.id;
    this.version = i.version;
    this.config = i.config;
    this.logger = i.logger;
    this.tracer = i.tracer;
    this.meter = i.meter;
    this.registry = i.metrics.registry;
  }

  /** The member's database handle, bound to PG_USER + PG_SCHEMA (P10). */
  store(): Store {
    if (!this.i.store) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "db" }, "this component declares no PG_SCHEMA");
    return this.i.store();
  }

  /** The cached channel to a dependency's port (P7.6); an optional dependency not installed throws DependencyAbsentError. */
  conn(dependency: string, port = "grpc"): ChannelInterface {
    return this.i.grpc.conn(dependency, port);
  }

  /**
   * A generated grpc-js client over the shared channel, with the runtime's interceptors. `schema` is the
   * contract's `protoMetadata` (ts-proto outputSchema=true): retries come from its idempotency levels (P7.8).
   */
  client<C>(ctor: ClientCtor<C>, dependency: string, schema: ProtoMetadataLike, port = "grpc"): C {
    return this.i.grpc.client(ctor, dependency, schema, port);
  }

  /** A slot family's gRPC client, at AUTHZ_GRPC_URL or IAM_GRPC_URL (P2.10). */
  familyClient<C>(ctor: ClientCtor<C>, key: FamilyGrpcKey, schema: ProtoMetadataLike): C {
    return this.i.grpc.familyClient(ctor, key, schema);
  }

  /** Another component's user plane, called with the caller's own token (P8.1). */
  userHttp(dependency: string): UserHttp {
    let u = this.users.get(dependency);
    if (!u) {
      const address = this.config.endpoint(dependency);
      if (address === undefined) throw new DependencyAbsentError(dependency, "");
      u = new UserHttp({ memberId: this.id, dependency, address, metrics: this.i.metrics });
      this.users.set(dependency, u);
    }
    return u;
  }

  /** A named third-party client (P8.3). */
  externalHttp(name: string, opts: { timeoutMs?: number; maxConns?: number } = {}): ExternalHttp {
    let e = this.externals.get(name);
    if (!e) {
      e = new ExternalHttp({ memberId: this.id, name, metrics: this.i.metrics, ...opts });
      this.externals.set(name, e);
    }
    return e;
  }

  /** @internal closes the clients this runtime handed out */
  async close(): Promise<void> {
    this.i.grpc.close();
    await Promise.allSettled([...this.users.values(), ...this.externals.values()].map((c) => c.close()));
  }
}

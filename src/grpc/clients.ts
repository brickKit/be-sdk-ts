// Outbound gRPC (P7.6–P7.9, P7.12): one channel per (member, dependency, port), created lazily, closed at stop;
// every generated client of that dependency shares it and goes through the member's interceptor chain.
//
// Retries come from a service config built from the contracts' generated `protoMetadata` (P7.8), so a client is
// created with its schema: `clients.client(InventoryServiceClient, "erp/inventory", inventoryProto)`. A channel's
// service config is fixed when it is dialled; a schema registered later that adds retryable methods replaces the
// channel (the old one finishes its calls and is closed), which happens at most once per schema in practice since
// clients are made in `create(rt)`.
import {
  Channel, credentials, Metadata,
  type CallOptions, type ChannelInterface, type ChannelOptions, type ClientOptions, type connectivityState, type ServiceError,
} from "@grpc/grpc-js";
import { BeError } from "../errors/beError.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { Bulkhead, clientChain } from "./clientInterceptors.js";
import { serviceConfig, type ProtoMetadataLike } from "./descriptors.js";
import { DependencyAbsentError } from "../errors/dependencyAbsent.js";
import { fromStatus } from "./errors.js";

export type FamilyGrpcKey = "AUTHZ_GRPC_URL" | "IAM_GRPC_URL";

/** The slot family a `*_GRPC_URL` addresses: its ID labels metrics and keys the bulkhead (P2.10). */
const FAMILY_ID: Record<FamilyGrpcKey, string> = { AUTHZ_GRPC_URL: "infra/authz", IAM_GRPC_URL: "infra/iam" };

export interface AddressSource {
  /** host:port of `<DEP>[_<PORT>]_ENDPOINT`, undefined when the variable does not exist */
  endpoint(dependency: string, port?: string): string | undefined;
  familyAddress(key: FamilyGrpcKey): string | undefined;
}

export interface GrpcClientsDeps {
  memberId: string;
  config: AddressSource;
  metrics: MemberRegistry;
}

export type ClientCtor<C> = new (address: string, creds: ReturnType<typeof credentials.createInsecure>, options?: Partial<ClientOptions>) => C;

/** P7.6 keepalive: ping after 30 s idle on an active call, 10 s timeout, never without calls. */
const CHANNEL_OPTIONS: ChannelOptions = {
  "grpc.keepalive_time_ms": 30_000,
  "grpc.keepalive_timeout_ms": 10_000,
  "grpc.keepalive_permit_without_calls": 0,
  "grpc.enable_retries": 1,
};

type CreateCallArgs = Parameters<ChannelInterface["createCall"]>;

/**
 * The channel every client of one dependency shares. It dials on first use with the service config of every
 * schema registered so far. `close()` is a no-op so that a component calling `client.close()` cannot close a
 * channel other clients use; the runtime closes it with `shutdown()` at stop.
 */
class SharedChannel implements ChannelInterface {
  private readonly target: string;
  private readonly schemas = new Set<ProtoMetadataLike>();
  private inner: Channel | undefined;
  private configJson = "";
  private stopped = false;

  constructor(target: string) {
    this.target = target;
  }

  register(schema: ProtoMetadataLike): void {
    if (this.schemas.has(schema)) return;
    this.schemas.add(schema);
    if (this.inner && JSON.stringify(serviceConfig(this.schemas)) !== this.configJson) {
      const old = this.inner;
      this.inner = undefined;
      old.close(); // started calls finish; only calls still waiting for a connection are failed
    }
  }

  private channel(): Channel {
    if (this.stopped) throw new BeError("UNAVAILABLE", "", { message: `channel to ${this.target} is closed` });
    if (!this.inner) {
      this.configJson = JSON.stringify(serviceConfig(this.schemas));
      this.inner = new Channel(this.target, credentials.createInsecure(), { ...CHANNEL_OPTIONS, "grpc.service_config": this.configJson });
    }
    return this.inner;
  }

  close(): void {}

  shutdown(): void {
    this.stopped = true;
    this.inner?.close();
    this.inner = undefined;
  }

  getTarget(): string {
    return this.channel().getTarget();
  }
  getConnectivityState(tryToConnect: boolean): connectivityState {
    return this.channel().getConnectivityState(tryToConnect);
  }
  watchConnectivityState(state: connectivityState, deadline: Date | number, cb: (error?: Error) => void): void {
    this.channel().watchConnectivityState(state, deadline, cb);
  }
  getChannelzRef(): ReturnType<ChannelInterface["getChannelzRef"]> {
    return this.channel().getChannelzRef();
  }
  createCall(...args: CreateCallArgs): ReturnType<ChannelInterface["createCall"]> {
    return this.channel().createCall(...args);
  }
}

interface Dependency {
  channel: SharedChannel;
  /** the interceptor chain, one per (member, dependency): its bulkhead counts every port of the dependency */
  chain: ReturnType<typeof clientChain>;
}

export class GrpcClients {
  private readonly d: GrpcClientsDeps;
  private readonly channels = new Map<string, SharedChannel>();
  private readonly chains = new Map<string, ReturnType<typeof clientChain>>();

  constructor(d: GrpcClientsDeps) {
    this.d = d;
  }

  /**
   * The cached channel to a dependency's port (`<DEP>_GRPC_ENDPOINT` by default). Throws DependencyAbsentError
   * when the address variable does not exist: an optional dependency that is not installed (P2.5).
   * A channel used directly gets the service config of the schemas registered with `register()`.
   */
  conn(dependency: string, port = "grpc"): ChannelInterface {
    return this.dependency(dependency, port).channel;
  }

  /** The channel to a slot family's gRPC address (`AUTHZ_GRPC_URL`, `IAM_GRPC_URL`). */
  familyConn(key: FamilyGrpcKey): ChannelInterface {
    return this.family(key).channel;
  }

  /** Adds a contract's retryable methods to the dependency's service config before its first call. */
  register(dependency: string, schema: ProtoMetadataLike, port = "grpc"): void {
    this.dependency(dependency, port).channel.register(schema);
  }

  /** A generated client over the dependency's shared channel, through the member's interceptor chain. */
  client<C>(ctor: ClientCtor<C>, dependency: string, schema: ProtoMetadataLike, port = "grpc"): C {
    return this.make(ctor, this.dependency(dependency, port), schema);
  }

  familyClient<C>(ctor: ClientCtor<C>, key: FamilyGrpcKey, schema: ProtoMetadataLike): C {
    return this.make(ctor, this.family(key), schema);
  }

  /** Closes every channel (P7.6: closed at stop). */
  close(): void {
    for (const c of this.channels.values()) c.shutdown();
    this.channels.clear();
  }

  private make<C>(ctor: ClientCtor<C>, dep: Dependency, schema: ProtoMetadataLike): C {
    dep.channel.register(schema);
    const interceptors = dep.chain;
    return new ctor("unused", credentials.createInsecure(), {
      channelOverride: dep.channel,
      interceptors,
      // per-call interceptors replace the client's in grpc-js: put the runtime's chain back in front of them
      callInvocationTransformer: (p) => {
        const o = p.callOptions;
        if (o.interceptors?.length) return { ...p, callOptions: { ...o, interceptors: [...interceptors, ...o.interceptors] } };
        if (o.interceptor_providers?.length) {
          return { ...p, callOptions: { ...o, interceptor_providers: [...interceptors.map((i) => () => i), ...o.interceptor_providers] } };
        }
        return p;
      },
    });
  }

  private dependency(dependency: string, port: string): Dependency {
    const address = this.d.config.endpoint(dependency, port);
    if (address === undefined) throw new DependencyAbsentError(dependency, port);
    return this.entry(dependency, `${dependency}#${port}`, address);
  }

  private family(key: FamilyGrpcKey): Dependency {
    const address = this.d.config.familyAddress(key);
    if (address === undefined) throw new DependencyAbsentError(FAMILY_ID[key], key);
    return this.entry(FAMILY_ID[key], `${key}#`, address);
  }

  private entry(target: string, key: string, address: string): Dependency {
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new SharedChannel(address);
      this.channels.set(key, channel);
    }
    let chain = this.chains.get(target);
    if (!chain) {
      chain = clientChain(this.d.memberId, target, new Bulkhead(), this.d.metrics);
      this.chains.set(target, chain);
    }
    return { channel, chain };
  }
}

type UnaryMethod<Req, Res> = (req: Req, md: Metadata, opts: Partial<CallOptions>, cb: (err: ServiceError | null, res?: Res) => void) => unknown;

/**
 * Promise form of a generated unary method; a failure is thrown as the dependency's BeError (fromStatus), so a
 * REST handler that awaits it relays the dependency's code, reason and domain (P4.2, P4.9).
 * `await unary(inventory.getStock.bind(inventory), { skuId })`
 */
export function unary<Req, Res>(method: UnaryMethod<Req, Res>, req: Req, opts: Partial<CallOptions> = {}): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    method(req, new Metadata(), opts, (err, res) => (err ? reject(fromStatus(err) ?? err) : resolve(res as Res)));
  });
}

// What a module's `create` receives (sdk-redesign-apis §4 Runtime): the member's identity, configuration,
// logger, tracer, meter and registry, and the factories of the runtime-owned clients. Built per member; never
// a process global, so a shell can host several.
import type { Meter, Tracer } from "@opentelemetry/api";
import type { Registry } from "@prometheus-io/client";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { platformError } from "../errors/beError.js";

export interface Clock {
  now(): Date;
}

/** Optional facilities a member wires in when its manifest asks for them. */
export interface RuntimeFacets<TStore = unknown, TClients = unknown> {
  store?: () => TStore;
  grpc?: TClients;
}

export class Runtime<TStore = any, TClients = any> {
  readonly id: string;
  readonly version: string;
  readonly config: Config;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly registry: Registry;
  readonly clock: Clock = { now: () => new Date() };
  /** @internal set by the member while it wires its facilities */
  facets: RuntimeFacets<TStore, TClients> = {};

  constructor(o: { id: string; version: string; config: Config; logger: Logger; tracer: Tracer; meter: Meter; registry: Registry }) {
    this.id = o.id;
    this.version = o.version;
    this.config = o.config;
    this.logger = o.logger;
    this.tracer = o.tracer;
    this.meter = o.meter;
    this.registry = o.registry;
  }

  /** The member's database handle, bound to PG_USER + PG_SCHEMA (P10). */
  store(): TStore {
    if (!this.facets.store) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "db" }, "this component declares no PG_SCHEMA");
    return this.facets.store();
  }
}

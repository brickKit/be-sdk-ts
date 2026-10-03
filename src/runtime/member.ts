// One member's life (P1): build the runtime, create the module (≤ 30 s), open the ports, start the background
// work under the supervisor, report readiness; on stop, drain requests within SHUTDOWN_GRACE, then stop the
// background work and close everything the member owns. The platform outlives its members (P19.3).
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import type { Manifest } from "../config/manifest.js";
import { PokeSubscriber } from "../auth/poke.js";
import { componentCatalog, type ErrorCatalog } from "../errors/catalog.js";
import { EventContracts } from "../events/contracts.js";
import { EventsRuntime } from "../events/runtime.js";
import { buildGrpcServer, type GrpcServer } from "../grpc/server.js";
import { GrpcClients } from "../grpc/clients.js";
import { Store } from "../store/store.js";
import type { TxExtensions } from "../store/tx.js";
import { checkDatabase, compareMigrations, imageMigrations } from "./database.js";
import { businessZone, jobsOverrides } from "../jobs/config.js";
import { JobsRuntime } from "../jobs/runtime.js";
import type { LifecycleEngine } from "../lifecycle/engine.js";
import { lifecycleJob, loadLifecycle, mountLifecycle } from "./lifecycle.js";
import type { Projection } from "../auth/projection.js";
import { mountResourceContract, projectionFor, projectionJob } from "./resources.js";
import { migrationVersions } from "../store/probe.js";
import { buildHttpServer, type HttpServer } from "../http/server.js";
import { errorFields } from "../log/logger.js";
import { newMemberRegistry, type MemberRegistry } from "../obs/metrics.js";
import type { MemberTelemetry } from "../obs/telemetry.js";
import { buildInfo, type InfoState } from "./info.js";
import type { Platform } from "./platform.js";
import { Readiness } from "./readiness.js";
import { Runtime } from "./runtime.js";
import type { Module, Spec } from "./spec.js";
import { Supervisor } from "./supervisor.js";

const INIT_TIMEOUT_MS = 30_000;

export class Member {
  readonly id: string;
  readonly version: string;
  readonly logger: Logger;
  readonly rt: Runtime;
  readonly readiness = new Readiness([]);
  readonly supervisor: Supervisor;
  private readonly spec: Spec;
  private readonly manifest: Manifest;
  private readonly config: Config;
  private readonly platform: Platform;
  private readonly metrics: MemberRegistry;
  private readonly telemetry: MemberTelemetry;
  private readonly http: HttpServer;
  private readonly info: InfoState = { ports: {}, migrations: { component: null, platform: null }, degraded: [], capabilities: [] };
  private module: Module | undefined;
  private readonly stopHooks: (() => Promise<void>)[] = [];
  private readonly catalog: ErrorCatalog;
  private readonly txExtensions: TxExtensions = {};
  private store: Store | undefined;
  private grpcServer: GrpcServer | undefined;
  private events: EventsRuntime | undefined;
  private poke: PokeSubscriber | undefined | null = null;
  private jobs: JobsRuntime | undefined;
  private lifecycle: LifecycleEngine | undefined;
  private projection: Projection | undefined;
  /** called when background work finds a fatal condition (P1.8); main exits non-zero */
  onFatal: (why: string) => void = () => {};

  constructor(o: { spec: Spec; manifest: Manifest; config: Config; version: string; logger: Logger; platform: Platform }) {
    this.spec = o.spec;
    this.manifest = o.manifest;
    this.config = o.config;
    this.platform = o.platform;
    this.id = o.spec.id;
    this.version = o.version;
    this.logger = o.logger;
    this.metrics = newMemberRegistry(this.id);
    this.telemetry = o.platform.telemetry.member(this.id, this.version);
    this.supervisor = new Supervisor(this.logger);
    this.catalog = componentCatalog(o.spec.errorDomain ?? this.id, o.spec.contracts ? `${o.spec.contracts}/errors.yaml` : undefined);
    if ("PG_SCHEMA" in o.manifest.properties) {
      this.store = new Store({ memberId: this.id, version: this.version, config: o.config, logger: o.logger, metrics: this.metrics, extensions: this.txExtensions });
    }
    const store = this.store;
    this.rt = new Runtime({
      id: this.id, version: this.version, config: o.config, logger: o.logger, tracer: this.telemetry.tracer,
      meter: this.metrics.meter, metrics: this.metrics,
      grpc: new GrpcClients({ memberId: this.id, config: o.config, metrics: this.metrics }),
      store: store ? () => store : undefined,
    });
    for (const s of o.config.allSecrets()) {
      s.watch({
        changed: (key) => this.logger.info({ key }, "secret_reloaded"),
        failed: (key, e) => {
          this.logger.error({ key, error: (e as Error).message }, "secret_reload_failed");
          this.metrics.be.secretReloadFailures.inc({ key });
        },
      });
    }
    this.http = buildHttpServer({
      memberId: this.id, errorDomain: o.spec.errorDomain, locale: localeOf(o.config),
      catalog: this.catalog,
      logger: this.logger, metrics: this.metrics, tracer: this.telemetry.tracer,
      defaultTimeoutMs: o.config.orDefault("HTTP_DEFAULT_TIMEOUT", (c) => c.duration("HTTP_DEFAULT_TIMEOUT", 10_000), 10_000),
      auth: { verifier: o.platform.verifier, bundle: o.platform.bundle },
      ops: { readiness: () => this.readiness.state(), info: () => buildInfo(this.manifest, this.version, this.info) },
    });
  }

  get memberMetrics(): MemberRegistry {
    return this.metrics;
  }

  /** Registers work done at stop, after the background work ended (store, bus, …). */
  onStop(fn: () => Promise<void>): void {
    this.stopHooks.push(fn);
  }

  /** Creates the module and registers its surfaces; throws when the initialisation fails (exit non-zero). */
  async init(): Promise<void> {
    this.module = await withTimeout(this.spec.create(this.rt), INIT_TIMEOUT_MS, "create");
    this.module.http?.(this.http.router);
    this.mountResources();
    const lc = this.loadLifecycle();
    if (lc && this.platform.bundle) mountLifecycle(this.http.router, this.id, lc);
    const jobs = (this.jobs = this.buildJobs(false));
    // P14.4 (SHOULD): only where the member authorizes at all, so a component without AUTHZ_URL is not held unready
    if (jobs && this.platform.bundle) this.http.router.get("/_ops/jobs", `${this.id.replace("/", ".")}.ops`, () => jobs.ops());
    if (this.module.grpc) this.mountGrpc(this.module.grpc);
    if (this.http.router.protectedRoutes > 0) this.watchBundle();
    if (this.store) this.watchDatabase(this.store);
    this.startEvents();
    jobs?.start(this.supervisor);
    if (this.module.start) await withTimeout(this.module.start(this.supervisor.signal), INIT_TIMEOUT_MS, "start");
  }

  /** The member's background work (P14); a ConfigError for a bad schedule or JOBS_OVERRIDES (exit 78). */
  private buildJobs(oneShot: boolean): JobsRuntime | undefined {
    const m = this.module!;
    if (!this.store) {
      if ((m.jobs?.length ?? 0) + (m.workers?.length ?? 0) + (m.reconcilers?.length ?? 0) > 0) throw new Error("Module.jobs / workers / reconcilers need a database: declare the db profile (PG_SCHEMA)");
      return undefined;
    }
    const jobs = new JobsRuntime({
      memberId: this.id, store: this.store, logger: this.logger, metrics: this.metrics, module: m,
      zone: businessZone(this.config), overrides: jobsOverrides(this.config), oneShot,
      platformJobs: [
        ...(this.lifecycle ? [lifecycleJob(this.lifecycle, (why) => this.onFatal(why))] : []),
        ...(this.projection ? [projectionJob(this.projection)] : []),
      ],
    });
    jobs.validate();
    Object.assign(this.txExtensions, jobs.extensions);
    this.info.capabilities = [...new Set([...this.info.capabilities, "job_run"])];
    return jobs;
  }

  /**
   * `job run <name>` (P14.8): the module is created, nothing is served and no other background work starts; the
   * schema must match the image; one run through the same tables. Exit code 0 (ran or no-op), 1, 64 or 78.
   */
  async runJob(name: string): Promise<number> {
    try {
      this.module = await withTimeout(this.spec.create(this.rt), INIT_TIMEOUT_MS, "create");
      this.loadLifecycle();
      const jobs = this.buildJobs(true);
      if (!jobs) return (this.logger.error({ job: name }, "job_unknown"), 64);
      if (this.module.events) this.eventsFor(this.store!);
      const schema = await this.schemaState(this.store!);
      if (schema !== "ok") return (this.logger.error({ job: name, schema }, "job_schema_mismatch"), 1);
      const r = await jobs.runOnce(name, this.supervisor.signal);
      if (r.result === "unknown") return (this.logger.error({ job: name }, "job_unknown"), 64);
      if (r.result === "noop") this.logger.info({ job: name, why: r.why }, "job_noop");
      else if (r.result === "ok") this.logger.info({ job: name }, "job_done");
      else this.logger.error({ job: name, why: r.why }, "job_failed");
      return r.result === "failed" ? 1 : 0;
    } finally {
      await this.store?.close();
      await this.telemetry.shutdown();
      await this.metrics.shutdown();
    }
  }

  /** Resource types (P6.10, P6.12): the projection, pulled as be.authz.changes and on a poke, and the resource contract. */
  private mountResources(): void {
    const types = this.spec.resources ?? [];
    if (types.length === 0 || !this.store || !this.platform.bundle) return;
    const authzUrl = this.config.familyAddress("AUTHZ_URL")!;
    const p = (this.projection = projectionFor(this.store, authzUrl, types, this.logger));
    let pulling: Promise<void> | undefined;
    this.pokes()?.on(() => void (pulling ??= p.pull().catch(() => undefined).finally(() => (pulling = undefined))));
    mountResourceContract(this.http.router, this.store, types, this.module?.records ?? {});
  }

  /** The lifecycle engine when the component ships lifecycle.yaml (P16); tx.seal goes to it. */
  private loadLifecycle(): LifecycleEngine | undefined {
    if (!this.store) return undefined;
    const lc = loadLifecycle({
      memberId: this.id, store: this.store, logger: this.logger, config: this.config, migrationsDir: this.spec.migrations,
      outbox: busUrl(this.config)?.startsWith("nats://") === true,
    });
    if (lc) this.txExtensions.seal = (tx, table, unit) => lc.sealInTx(tx, table, unit);
    this.lifecycle = lc;
    return lc;
  }

  private async schemaState(store: Store): Promise<string> {
    const v = await migrationVersions(store);
    return compareMigrations(v.applied, imageMigrations(this.spec.migrations), v.platform);
  }

  private watchBundle(): void {
    const b = this.platform.bundle;
    this.readiness.require("bundle");
    if (!b) return;
    void b.ready().then(() => this.readiness.met("bundle"));
    this.supervisor.run("be.authz.bundle", (signal) => b.run(signal));
    if (this.platform.verifier) void this.platform.verifier.warm();
    this.pokes()?.on(() => b.poke());
  }

  /** The member's own subscription to the authz poke (P12.10), when the bus is NATS; created on first use. */
  private pokes(): PokeSubscriber | undefined {
    if (this.poke !== null) return this.poke;
    const url = busUrl(this.config);
    this.poke = url?.startsWith("nats://") ? new PokeSubscriber({ url, name: this.id, logger: this.logger }) : undefined;
    const p = this.poke;
    if (p) this.supervisor.run("be.authz.poke", (signal) => p.run(signal));
    return p;
  }

  private mountGrpc(register: NonNullable<Module["grpc"]>): void {
    this.grpcServer = buildGrpcServer({
      memberId: this.id, errorDomain: this.spec.errorDomain, locale: localeOf(this.config), catalog: this.catalog, logger: this.logger,
      metrics: this.metrics, tracer: this.telemetry.tracer, maxConnectionAgeMs: this.config.orDefault("GRPC_MAX_CONNECTION_AGE", (c) => c.duration("GRPC_MAX_CONNECTION_AGE", 300_000), 300_000),
    });
    register(this.grpcServer);
  }

  private watchDatabase(store: Store): void {
    this.readiness.require("db_identity");
    this.readiness.require("migrations");
    this.supervisor.run("be.db.probe", (signal) => checkDatabase({
      store, ownerRole: this.config.require("PG_OWNER_USER"), migrationsDir: this.spec.migrations, shell: false,
      logger: this.logger, metrics: this.metrics, readiness: this.readiness, fatal: (why) => this.onFatal(why),
      report: (component, platform) => (this.info.migrations = { component, platform }),
    }, signal));
    this.onStop(() => store.close());
  }

  private startEvents(): void {
    const decl = this.module?.events;
    const runtimeEvents = this.lifecycle !== undefined && busUrl(this.config)?.startsWith("nats://") === true;
    if (!runtimeEvents && (!decl || ((decl.publishes ?? []).length === 0 && (decl.subscribe ?? []).length === 0))) return;
    if (!this.store) throw new Error("Module.events needs a database: declare the db profile (PG_SCHEMA) for the outbox and the cursor");
    this.events = this.eventsFor(this.store);
    this.events.start(this.supervisor);
    const events = this.events;
    this.onStop(() => events.stop());
  }

  /** The events runtime with tx.publish wired; started only when serving. */
  private eventsFor(store: Store): EventsRuntime {
    const events = new EventsRuntime({
      memberId: this.id, version: this.version, config: this.config, logger: this.logger, metrics: this.metrics, tracer: this.telemetry.tracer,
      store, contracts: EventContracts.load(this.spec.contracts), declaration: this.module!.events ?? {},
      runtimeEvents: this.lifecycle !== undefined,
    });
    Object.assign(this.txExtensions, events.extensions);
    return events;
  }

  async listen(port = this.manifest.port): Promise<string> {
    const base = await this.http.listen(port);
    this.info.ports.http = Number(new URL(base).port);
    if (this.grpcServer && this.grpcServer.serviceCount > 0) {
      const grpcPort = this.manifest.extraPorts.grpc;
      if (grpcPort === undefined) throw new Error("Module.grpc registers services but component.yaml declares no extra port named grpc");
      this.info.ports.grpc = await this.grpcServer.listen(grpcPort);
    }
    return base;
  }

  /** P1.6: stop accepting, drain within SHUTDOWN_GRACE, stop background work, close what the member owns. */
  async stop(): Promise<void> {
    const grace = this.config.orDefault("SHUTDOWN_GRACE", (c) => c.duration("SHUTDOWN_GRACE", 25_000), 25_000);
    const deadline = Date.now() + grace;
    await Promise.all([this.http.close(grace), this.grpcServer?.close(Math.min(grace, 30_000))]);
    await this.supervisor.stop(Math.max(1_000, deadline - Date.now()));
    await this.rt.close();
    for (const fn of this.stopHooks.splice(0).reverse()) await fn().catch((e) => this.logger.error(errorFields(e), "stop_hook_failed"));
    await this.module?.stop?.().catch((e) => this.logger.error(errorFields(e), "module_stop_failed"));
    for (const s of this.config.allSecrets()) s.stop();
    await this.telemetry.shutdown();
    await this.metrics.shutdown();
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`module ${what} exceeded ${ms / 1000} s`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** EVENT_BUS_URL, falling back to NATS_URL (P12.12); undefined when neither is set. */
export function busUrl(c: Config): string | undefined {
  return c.orDefault("EVENT_BUS_URL", (x) => x.string("EVENT_BUS_URL"), undefined) || c.orDefault("NATS_URL", (x) => x.string("NATS_URL"), undefined) || undefined;
}

function localeOf(c: Config): string {
  return c.orDefault("DEFAULT_LOCALE", (x) => x.string("DEFAULT_LOCALE", "zh-CN")!, "zh-CN");
}

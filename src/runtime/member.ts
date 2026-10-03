// One member's life (P1): build the runtime, create the module (≤ 30 s), open the ports, start the background
// work under the supervisor, report readiness; on stop, drain requests within SHUTDOWN_GRACE, then stop the
// background work and close everything the member owns. The platform outlives its members (P19.3).
import { metrics } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import type { Manifest } from "../config/manifest.js";
import { componentCatalog } from "../errors/catalog.js";
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
    this.rt = new Runtime({
      id: this.id, version: this.version, config: o.config, logger: o.logger, tracer: this.telemetry.tracer,
      meter: metrics.getMeterProvider().getMeter(this.id, this.version), registry: this.metrics.registry,
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
      memberId: this.id, locale: o.config.string("DEFAULT_LOCALE", "zh-CN") ?? "zh-CN",
      catalog: componentCatalog(this.id, o.spec.contracts ? `${o.spec.contracts}/errors.yaml` : undefined),
      logger: this.logger, metrics: this.metrics, tracer: this.telemetry.tracer,
      defaultTimeoutMs: o.config.duration("HTTP_DEFAULT_TIMEOUT", 10_000),
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
    if (this.http.router.protectedRoutes > 0) this.watchBundle();
    if (this.module.start) await withTimeout(this.module.start(this.supervisor.signal), INIT_TIMEOUT_MS, "start");
  }

  private watchBundle(): void {
    const b = this.platform.bundle;
    this.readiness.require("bundle");
    if (!b) return;
    void b.ready().then(() => this.readiness.met("bundle"));
    this.supervisor.run("be.authz.bundle", (signal) => b.run(signal));
    if (this.platform.verifier) void this.platform.verifier.warm();
  }

  async listen(port = this.manifest.port): Promise<string> {
    const base = await this.http.listen(port);
    this.info.ports.http = Number(new URL(base).port);
    return base;
  }

  /** P1.6: stop accepting, drain within SHUTDOWN_GRACE, stop background work, close what the member owns. */
  async stop(): Promise<void> {
    const grace = this.config.duration("SHUTDOWN_GRACE", 25_000);
    const deadline = Date.now() + grace;
    await this.http.close(grace);
    await this.supervisor.stop(Math.max(1_000, deadline - Date.now()));
    for (const fn of this.stopHooks.splice(0).reverse()) await fn().catch((e) => this.logger.error(errorFields(e), "stop_hook_failed"));
    await this.module?.stop?.().catch((e) => this.logger.error(errorFields(e), "module_stop_failed"));
    for (const s of this.config.allSecrets()) s.stop();
    await this.telemetry.shutdown();
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

// Traces (P18.1, P19.3): the platform owns the exporter and the propagator; each member gets its own tracer
// provider whose batch processor wraps the shared exporter in a shell whose shutdown does nothing, so a member
// stopping flushes only its own queue and never closes the exporter another member still uses (r1-01).
import { context, propagation, trace, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { hostname } from "node:os";

export interface TelemetryOptions {
  /** service.namespace; default the member's domain (the first segment of its ID, P18.1) */
  namespace?: string;
  /** deployment.environment.name = DEPLOY_ENV (default "dev", P18.1) */
  environment?: string;
}

/** The member's view of the shared exporter: export and flush pass through, shutdown is a no-op. */
class MemberExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  constructor(inner: SpanExporter) {
    this.inner = inner;
  }
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    this.inner.export(spans, done);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.();
  }
}

export interface MemberTelemetry {
  tracer: Tracer;
  provider: BasicTracerProvider;
  /** flushes this member's queue; the shared exporter stays open */
  shutdown(): Promise<void>;
}

let contextManagerInstalled = false;

export class Telemetry {
  private readonly exporter: SpanExporter | undefined;
  private readonly opts: TelemetryOptions;

  private constructor(exporter: SpanExporter | undefined, opts: TelemetryOptions) {
    this.exporter = exporter;
    this.opts = opts;
    // process-wide, installed once: the context manager (active span across awaits) and the propagator
    if (!contextManagerInstalled) {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      contextManagerInstalled = true;
    }
    propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));
  }

  /** OTLP/HTTP to `{base}/v1/traces`; empty base = no export (spans still get valid IDs). */
  static create(otelBaseUrl: string, opts: TelemetryOptions): Telemetry {
    const base = otelBaseUrl.replace(/\/+$/, "");
    return new Telemetry(base ? new OTLPTraceExporter({ url: `${base}/v1/traces` }) : undefined, opts);
  }

  static withExporter(exporter: SpanExporter, opts: TelemetryOptions): Telemetry {
    return new Telemetry(exporter, opts);
  }

  member(componentId: string, version: string): MemberTelemetry {
    const attrs: Record<string, string> = { "service.name": componentId, "service.version": version, "service.instance.id": hostname() };
    attrs["service.namespace"] = this.opts.namespace || componentId.split("/")[0]!;
    attrs["deployment.environment.name"] = this.opts.environment || "dev";
    const resource = resourceFromAttributes(attrs);
    const processors = this.exporter ? [new BatchSpanProcessor(new MemberExporter(this.exporter), { scheduledDelayMillis: 1000 })] : [];
    const provider = new BasicTracerProvider({ resource, spanProcessors: processors });
    return { tracer: provider.getTracer(componentId, version), provider, shutdown: () => provider.shutdown() };
  }

  /** Called once, after every member stopped (P19.3). */
  async shutdown(): Promise<void> {
    await this.exporter?.shutdown();
  }

  /** The global tracer provider is the fallback only: a span with the shell's (or process') ID reveals a missed instrumentation. */
  setGlobalFallback(id: string): void {
    trace.setGlobalTracerProvider(this.member(id, "fallback").provider);
  }
}

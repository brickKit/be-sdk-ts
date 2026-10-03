import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { context, propagation, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";

describe("Telemetry", () => {
  it("gives each member its own provider over one shared exporter that only the platform shuts down", async () => {
    const exporter = new InMemorySpanExporter();
    const t = Telemetry.withExporter(exporter, { namespace: "proj", environment: "test" });
    const a = t.member("erp/sales", "3.0.0");
    const b = t.member("erp/finance", "3.0.0");
    a.tracer.startSpan("a1").end();
    await a.shutdown(); // stopping one member flushes its own queue only
    b.tracer.startSpan("b1").end();
    await b.shutdown();
    const names = exporter.getFinishedSpans().map((s) => [s.name, s.resource.attributes["service.name"]]);
    expect(names).toEqual([["a1", "erp/sales"], ["b1", "erp/finance"]]);
    await t.shutdown();
  });

  it("spans have valid trace IDs when nothing is exported", () => {
    const t = Telemetry.create("", { namespace: "p", environment: "e" });
    const span = t.member("a/b", "1.0.0").tracer.startSpan("x");
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanContext().traceId).not.toBe("0".repeat(32));
    span.end();
  });

  it("uses W3C trace context and baggage", () => {
    Telemetry.create("", { namespace: "p", environment: "e" });
    const carrier: Record<string, string> = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", baggage: "k=v" };
    const ctx = propagation.extract(context.active(), carrier);
    expect(trace.getSpanContext(ctx)?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    const out: Record<string, string> = {};
    propagation.inject(ctx, out);
    expect(out.traceparent).toBe(carrier.traceparent);
    expect(out.baggage).toBe("k=v");
  });
});

describe("metrics registry", () => {
  it("labels every series with the component", async () => {
    const r = newMemberRegistry("erp/sales");
    r.be.httpServerRequests.inc({ method: "GET", route: "/x", status_code: "200" });
    const text = await r.registry.metrics();
    expect(text).toContain('be_http_server_requests_total{method="GET",route="/x",status_code="200",component="erp/sales"} 1');
  });
});

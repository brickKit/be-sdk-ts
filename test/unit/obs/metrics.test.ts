// rt.meter is a real OpenTelemetry meter (stage-B gap T1–T3): its instruments are exported on the member's
// /metrics next to the be_ series, every series labelled `component` (P18.3); two members never share series.
import { describe, expect, it } from "vitest";
import { newMemberRegistry } from "../../../src/obs/metrics.js";

describe("member meter (P18.3)", () => {
  it("exports an OTel counter and histogram with the component label", async () => {
    const m = newMemberRegistry("erp/sales");
    m.meter.createCounter("orders_confirmed", { description: "orders confirmed" }).add(3, { channel: "web" });
    m.meter.createHistogram("pricing_seconds", { unit: "s" }).record(0.2);
    const text = await m.render();
    expect(text).toMatch(/^orders_confirmed(_total)?\{[^}]*channel="web"[^}]*\} 3$/m);
    expect(text).toMatch(/orders_confirmed(_total)?\{[^}]*component="erp\/sales"/);
    expect(text).toMatch(/pricing_seconds_bucket\{[^}]*component="erp\/sales"/);
    expect(text).toContain("be_http_server_requests_total"); // the protocol series are still there
  });
  it("keeps each member's instruments apart", async () => {
    const a = newMemberRegistry("erp/a");
    const b = newMemberRegistry("erp/b");
    a.meter.createCounter("only_in_a").add(1);
    expect(await a.render()).toContain("only_in_a");
    expect(await b.render()).not.toContain("only_in_a");
  });
});

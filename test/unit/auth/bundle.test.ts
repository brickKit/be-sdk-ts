import { afterEach, describe, expect, it } from "vitest";
import { BundleSource } from "../../../src/auth/bundle.js";
import { bundle, fakeAuthz, type FakeAuthz } from "../../support/fakeAuthz.js";

let srv: FakeAuthz | undefined;
afterEach(async () => srv?.close());

const errors: string[] = [];
const src = (url: string) => new BundleSource({ authzUrl: url, onRefused: (why) => errors.push(why) });

describe("BundleSource (P6.1)", () => {
  it("loads, then revalidates with If-None-Match", async () => {
    srv = await fakeAuthz();
    const b = src(srv.url);
    expect(b.current()).toBeUndefined();
    expect(await b.fetchOnce()).toBe(true);
    expect(b.current()?.roles).toEqual({ rep: ["sdktest.basic.view"] });
    expect(await b.fetchOnce()).toBe(true);
    expect(srv.requests.map((r) => r.inm)).toEqual([undefined, '"v1"']);
  });

  it("refuses a bundle of another contract and keeps the one held", async () => {
    srv = await fakeAuthz();
    const b = src(srv.url);
    await b.fetchOnce();
    srv.setBundle({ ...bundle({ rep: [] }), contract: "authz/1.0" });
    expect(await b.fetchOnce()).toBe(false);
    expect(b.current()?.roles).toEqual({ rep: ["sdktest.basic.view"] });
    expect(errors.at(-1)).toMatch(/authz\/1.0/);
  });

  it("is fail-static when the provider is down", async () => {
    srv = await fakeAuthz();
    const b = src(srv.url);
    await b.fetchOnce();
    srv.down(true);
    expect(await b.fetchOnce()).toBe(false);
    expect(b.current()).toBeDefined();
  });

  it("polls in the background, backs off before the first load, and fetches at once on a poke", async () => {
    srv = await fakeAuthz();
    srv.down(true);
    const b = new BundleSource({ authzUrl: srv.url, pollMs: 60_000, firstRetryMs: 20 });
    const ac = new AbortController();
    const loop = b.run(ac.signal);
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.requests.length).toBeGreaterThanOrEqual(3); // 20, 40, … ms backoff
    srv.down(false);
    await b.ready();
    const n = srv.requests.length;
    srv.setBundle(bundle({ rep: ["x"] }));
    b.poke();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.requests.length).toBe(n + 1);
    expect(b.current()?.roles).toEqual({ rep: ["x"] });
    ac.abort();
    await loop;
  });
});

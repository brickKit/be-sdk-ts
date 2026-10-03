// The authz poke (P12.10, P6.1, P6.12): a core-NATS subscription on infra.authz.changed.v1, one per member,
// that wakes the bundle poll and the projection pull at once; nothing stored, nothing redelivered.
import { connect } from "@nats-io/transport-node";
import { describe, expect, it } from "vitest";
import { POKE_SUBJECT, PokeSubscriber } from "../../../src/auth/poke.js";
import { captureLogger } from "../../support/capture.js";
import { requireEnv } from "../../support/env.js";

const url = requireEnv("BE_TEST_NATS");

describe("PokeSubscriber", () => {
  it("calls every listener of each member on a core publish, with the parsed payload", async () => {
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const a = new PokeSubscriber({ url, name: "sdktest/a", logger: captureLogger().logger });
    const b = new PokeSubscriber({ url, name: "sdktest/b", logger: captureLogger().logger });
    a.on((p) => seenA.push(p));
    b.on((p) => seenB.push(p));
    const ac = new AbortController();
    const runs = [a.run(ac.signal), b.run(ac.signal)];
    await Promise.all([a.subscribed(), b.subscribed()]);
    const nc = await connect({ servers: url });
    nc.publish(POKE_SUBJECT, JSON.stringify({ revision: "42", bundle: true }));
    await nc.flush();
    for (let i = 0; i < 40 && (seenA.length === 0 || seenB.length === 0); i++) await new Promise((r) => setTimeout(r, 25));
    await nc.close();
    ac.abort();
    await Promise.all(runs);
    expect(seenA).toEqual([{ revision: "42", bundle: true }]);
    expect(seenB).toEqual([{ revision: "42", bundle: true }]);
  });
  it("still wakes the listeners when the payload does not parse (a poke only moves the next poll)", async () => {
    const seen: unknown[] = [];
    const s = new PokeSubscriber({ url, name: "sdktest/c", logger: captureLogger().logger });
    s.on((p) => seen.push(p));
    const ac = new AbortController();
    const run = s.run(ac.signal);
    await s.subscribed();
    const nc = await connect({ servers: url });
    nc.publish(POKE_SUBJECT, "garbage");
    await nc.flush();
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    await nc.close();
    ac.abort();
    await run;
    expect(seen).toEqual([{}]);
  });
});

describe("a member subscribes to the poke (P6.1)", () => {
  it("fetches the bundle at once on a poke instead of waiting for the 15 s poll", async () => {
    const { runMain } = await import("../../../src/runtime/main.js");
    const { defineComponent } = await import("../../../src/runtime/spec.js");
    const { tempComponent } = await import("../../support/component.js");
    const { bundle, fakeAuthz } = await import("../../support/fakeAuthz.js");
    const { fakeIam } = await import("../../support/fakeIam.js");
    const iam = await fakeIam();
    const authz = await fakeAuthz(bundle({ rep: [] }));
    const comp = tempComponent({ properties: `
    AUTHZ_URL: {type: string}
    IAM_URL: {type: string}
    IAM_ISSUER: {type: string}
    TENANT_ID: {type: string}
    NATS_URL: {type: string}` });
    const spec = defineComponent({ id: "sdktest/basic", manifest: comp.manifest, create: async () => ({ http: (r) => r.get("/x", "sdktest.basic.view", async () => ({ ok: true })) }) });
    const env = { COMPONENT_ID: "sdktest/basic", AUTHZ_URL: authz.url, IAM_URL: iam.url, IAM_ISSUER: iam.issuer, TENANT_ID: iam.tenant, NATS_URL: url };
    const r = await runMain(spec, { argv: [], env, stdout: { write: () => true } });
    if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}`);
    try {
      const tok = { authorization: `Bearer ${await iam.sign()}` };
      for (let i = 0; i < 40 && (await fetch(`${r.handle.baseUrl}/readyz`)).status !== 200; i++) await new Promise((res) => setTimeout(res, 50));
      expect((await fetch(`${r.handle.baseUrl}/sdktest/basic/x`, { headers: tok })).status).toBe(403);
      await new Promise((res) => setTimeout(res, 300)); // the member's subscription is registered
      authz.setBundle(bundle({ rep: ["sdktest.basic.view"] }));
      const nc = await connect({ servers: url });
      nc.publish(POKE_SUBJECT, JSON.stringify({ revision: "2", bundle: true }));
      await nc.flush();
      await nc.close();
      let status = 0;
      for (let i = 0; i < 40 && status !== 200; i++) {
        await new Promise((res) => setTimeout(res, 50));
        status = (await fetch(`${r.handle.baseUrl}/sdktest/basic/x`, { headers: tok })).status;
      }
      expect(status).toBe(200);
    } finally {
      await r.handle.stop();
      await iam.close();
      await authz.close();
    }
  });
});

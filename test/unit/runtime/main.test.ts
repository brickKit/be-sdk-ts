import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHENTICATED, PUBLIC } from "../../../src/auth/guard.js";
import { access } from "../../../src/auth/access.js";
import { runMain, type ServeHandle } from "../../../src/runtime/main.js";
import { defineComponent, type Module } from "../../../src/runtime/spec.js";
import { tempComponent } from "../../support/component.js";
import { fakeAuthz, type FakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam, type FakeIam } from "../../support/fakeIam.js";

function out() {
  const lines: any[] = [];
  const stdout = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
  return { lines, stdout };
}

let iam: FakeIam;
let authz: FakeAuthz;
beforeAll(async () => {
  iam = await fakeIam();
  authz = await fakeAuthz();
});
afterAll(async () => {
  await iam.close();
  await authz.close();
});

const comp = tempComponent();
const env = () => ({ COMPONENT_ID: "sdktest/basic", COMPONENT_VERSION: "3.0.0", AUTHZ_URL: authz.url, IAM_URL: iam.url, IAM_ISSUER: iam.issuer, TENANT_ID: iam.tenant });
let slowDone = false;
const spec = (over: Partial<Module> = {}, create?: () => Promise<Module>) =>
  defineComponent({
    id: "sdktest/basic",
    manifest: comp.manifest,
    create: create ?? (async () => ({
      http: (r) => {
        r.get("/hello", PUBLIC, async () => ({ hello: "world" }));
        r.get("/me", AUTHENTICATED, async () => ({ sub: access().user().sub }));
        r.get("/slow", PUBLIC, async () => {
          await new Promise((res) => setTimeout(res, 300));
          slowDone = true;
          return { ok: true };
        });
      },
      ...over,
    })),
  });

describe("runMain entry points (P1.1, P1.2, P1.8)", () => {
  it("exits 64 at once for an argument it does not know, before reading the configuration", async () => {
    const o = out();
    expect(await runMain(spec(), { argv: ["serve-please"], env: {}, stdout: o.stdout })).toEqual({ exitCode: 64 });
    expect(await runMain(spec(), { argv: ["migrate", "sideways"], env: {}, stdout: o.stdout })).toEqual({ exitCode: 64 });
  });

  it("exits 78 naming every bad key", async () => {
    const o = out();
    const r = await runMain(spec(), { argv: [], env: { ...env(), AUTHZ_URL: "http://nope", LOG_LEVEL: "loud" }, stdout: o.stdout });
    expect(r).toEqual({ exitCode: 78 });
    expect(o.lines.map((l) => [l.key, l.reason])).toEqual([["AUTHZ_URL", "CONFIG_INVALID"], ["LOG_LEVEL", "CONFIG_INVALID"]]);
    expect(o.lines[0]).toMatchObject({ level: "error", msg: "config_invalid", component_id: "sdktest/basic" });
  });

  it("exits 78 when COMPONENT_ID differs from the spec", async () => {
    const o = out();
    expect(await runMain(spec(), { argv: [], env: { ...env(), COMPONENT_ID: "sdktest/other" }, stdout: o.stdout })).toEqual({ exitCode: 78 });
  });

  it("exits 64 for job run of an unknown job, after validating the configuration", async () => {
    const o = out();
    expect(await runMain(spec(), { argv: ["job", "run", "nope"], env: env(), stdout: o.stdout })).toEqual({ exitCode: 64 });
    expect(await runMain(spec(), { argv: ["job", "run", "nope"], env: { ...env(), LOG_LEVEL: "x" }, stdout: o.stdout })).toEqual({ exitCode: 78 });
  });

  it("exits non-zero when the module's initialisation fails", async () => {
    const o = out();
    const r = await runMain(spec({}, async () => { throw new Error("cannot init"); }), { argv: [], env: env(), stdout: o.stdout });
    expect(r).toEqual({ exitCode: 1 });
    expect(o.lines.some((l) => l.level === "error" && String(l.error).includes("cannot init"))).toBe(true);
  });
});

describe("serving (P1.2–P1.6, P20)", () => {
  let h: ServeHandle;
  const o = out();
  beforeAll(async () => {
    const r = await runMain(spec(), { argv: [], env: env(), stdout: o.stdout });
    if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}`);
    h = r.handle;
  });

  it("serves routes and reports readiness once the bundle is loaded", async () => {
    expect(await (await fetch(`${h.baseUrl}/sdktest/basic/hello`)).json()).toEqual({ hello: "world" });
    for (let i = 0; i < 50 && (await fetch(`${h.baseUrl}/readyz`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${h.baseUrl}/readyz`)).status).toBe(200);
    const me = await fetch(`${h.baseUrl}/sdktest/basic/me`, { headers: { authorization: `Bearer ${await iam.sign()}` } });
    expect(await me.json()).toEqual({ sub: "u_me" });
  });

  it("describes itself at /_be/info", async () => {
    const info = (await (await fetch(`${h.baseUrl}/_be/info`)).json()) as Record<string, any>;
    expect(info).toMatchObject({
      component_id: "sdktest/basic", component_version: "3.0.0", protocol: "1.0",
      sdk: { name: "be-sdk-ts", version: expect.stringMatching(/^0\.6\.0/) }, language: { name: "node" }, members: null,
    });
    expect(info.profiles).toEqual(expect.arrayContaining(["core", "obs", "err", "auth"]));
    expect(info.ports.http).toBe(Number(new URL(h.baseUrl).port));
    expect(info.tzdata).toMatch(/^\d{4}[a-z]$/);
  });

  it("on stop lets an in-flight request finish, then stops accepting", async () => {
    const inflight = fetch(`${h.baseUrl}/sdktest/basic/slow`);
    await new Promise((r) => setTimeout(r, 50));
    await h.stop();
    expect((await inflight).status).toBe(200);
    expect(slowDone).toBe(true);
    await expect(fetch(`${h.baseUrl}/healthz`)).rejects.toThrow();
  });
});

import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../../../src/config/config.js";
import { ConfigErrors } from "../../../src/config/configError.js";
import { readManifest } from "../../../src/config/manifest.js";

const manifest = readManifest(new URL("../../fixtures/basic/component.yaml", import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), "besdk-cfg-"));
const pw = join(dir, "PG_PASSWORD_FILE");
writeFileSync(pw, "s3cr3t\n");

const env = (over: Record<string, string | undefined> = {}) => ({
  PG_HOST: "db", PG_DATABASE: "d", PG_USER: "u", PG_PASSWORD_FILE: pw, PG_SCHEMA: "s",
  AUTHZ_URL: "http://authz:8223", IAM_URL: "http://iam:8200", NATS_URL: "nats://n:4222",
  COMPONENT_ID: "sdktest/basic", SDKTEST_PEER_GRPC_ENDPOINT: "http://peer-1-0-0:9091/", ...over,
});

function errorsOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigErrors) return e.errors.map((x) => [x.key, x.reason]);
    throw e;
  }
  return [];
}

describe("Config", () => {
  it("reads the manifest", () => {
    expect(manifest.id).toBe("sdktest/basic");
    expect(manifest.port).toBe(8080);
    expect(manifest.extraPorts).toEqual({ grpc: 9090 });
    expect(manifest.dependencies).toEqual([{ id: "sdktest/peer", optional: false }, { id: "mdm/org", optional: true }]);
  });

  it("collects every problem of one start", () => {
    const errs = errorsOf(() => Config.load(manifest, env({ PG_HOST: undefined, HTTP_DEFAULT_TIMEOUT: "ten", BASIC_LIMIT: "x" })));
    expect(errs).toEqual([["PG_HOST", "CONFIG_MISSING"], ["HTTP_DEFAULT_TIMEOUT", "CONFIG_INVALID"], ["BASIC_LIMIT", "CONFIG_INVALID"]]);
  });

  it("parses protocol keys by the catalogue's format and component keys by their schema type", () => {
    const c = Config.load(manifest, env({ BASIC_FLAG: "1" }));
    expect(c.duration("HTTP_DEFAULT_TIMEOUT")).toBe(10_000);
    expect(c.durations("EVENTS_BACKOFF")[1]).toBe(10_000);
    expect(c.int("BASIC_LIMIT")).toBe(7);
    expect(c.bool("BASIC_FLAG")).toBe(true);
    expect(c.int("PG_PORT")).toBe(5432);
    expect(errorsOf(() => Config.load(manifest, env({ BASIC_MODE: "c" })))).toEqual([["BASIC_MODE", "CONFIG_INVALID"]]);
    expect(errorsOf(() => Config.load(manifest, env({ LOG_LEVEL: "WARN" })))).toEqual([["LOG_LEVEL", "CONFIG_INVALID"]]);
  });

  it("refuses a read of an undeclared key, allows platform names", () => {
    const c = Config.load(manifest, env());
    expect(() => c.string("OTHER_KEY")).toThrow(/not declared/);
    expect(c.string("COMPONENT_ID")).toBe("sdktest/basic");
  });

  it("falls back as the catalogue says", () => {
    const c = Config.load(manifest, env());
    expect(c.string("PG_MIGRATION_HOST")).toBe("db");
    expect(c.string("EVENT_BUS_URL")).toBe("nats://n:4222");
    expect(errorsOf(() => Config.load(manifest, env({ NATS_URL: undefined })))).toEqual([["EVENT_BUS_URL", "CONFIG_MISSING"]]);
  });

  it("reads addresses", () => {
    const c = Config.load(manifest, env());
    expect(c.endpoint("sdktest/peer", "grpc")).toBe("peer-1-0-0:9091");
    expect(c.endpoint("mdm/org", "grpc")).toBeUndefined();
    expect(c.familyAddress("AUTHZ_URL")).toBe("http://authz:8223");
    expect(errorsOf(() => Config.load(manifest, env({ AUTHZ_URL: "http://authz" })))).toEqual([["AUTHZ_URL", "CONFIG_INVALID"]]);
  });

  it("reads a secret from its file and re-reads it when the file changes", () => {
    const c = Config.load(manifest, env());
    expect(c.string("PG_PASSWORD_FILE")).toBe(pw);
    const s = c.secret("PG_PASSWORD_FILE");
    expect(s.current()).toBe("s3cr3t");
    writeFileSync(pw, "n3w-v4lue\n");
    utimesSync(pw, new Date(), new Date(Date.now() + 5000));
    expect(s.reload()).toBe(true);
    expect(s.current()).toBe("n3w-v4lue");
    expect(() => c.secret("PG_HOST")).toThrow(/not a secret/);
  });

  it("refuses a missing secret file at start", () => {
    expect(errorsOf(() => Config.load(manifest, env({ PG_PASSWORD_FILE: join(dir, "nope") })))).toEqual([["PG_PASSWORD_FILE", "CONFIG_INVALID"]]);
  });
});

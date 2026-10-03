// P16.9: the value of DATA_LIFECYCLE.
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/config/configError.js";
import { parseDataLifecycle } from "../../../src/lifecycle/config.js";
import { loadDeclaration } from "../../../src/lifecycle/declaration.js";

const decl = loadDeclaration(new URL("../../fixtures/lifecycle/widget/migrations/", import.meta.url).pathname);

function fails(raw: unknown): ConfigError {
  try {
    parseDataLifecycle(raw as string, decl);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).key).toBe("DATA_LIFECYCLE");
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("DATA_LIFECYCLE", () => {
  it("defaults to mode on with every adapter none", () => {
    expect(parseDataLifecycle(undefined, decl)).toEqual({
      mode: "on", cold_store: "none", cold_query: "none", publisher: "none", pii: "plain", dialect: "pg-native", tables: {},
    });
    expect(parseDataLifecycle("", decl).mode).toBe("on");
  });

  it("reads YAML 1.2 core: on and off are strings; JSON and an already parsed object are accepted", () => {
    expect(parseDataLifecycle("mode: on\n", decl).mode).toBe("on");
    expect(parseDataLifecycle("mode: off\n", decl).mode).toBe("off");
    expect(parseDataLifecycle('{"mode":"dry-run"}', decl).mode).toBe("dry-run");
    expect(parseDataLifecycle({ mode: "off" }, decl).mode).toBe("off");
  });

  it("an adapter this SDK does not have fails naming it", () => {
    const e = fails("cold_store: s3-parquet\n");
    expect(e.message).toContain("s3-parquet");
    expect(e.message).toContain("not supported by be-sdk-ts 0.6.0");
    expect(fails('{"cold_query":"trino"}').message).toContain("trino");
    expect(fails('{"publisher":"debezium"}').message).toContain("debezium");
    expect(fails('{"pii":"crypto-shred"}').message).toContain("crypto-shred");
  });

  it("an unknown adapter name or key fails", () => {
    expect(fails('{"cold_store":"tape"}').message).toContain("tape");
    expect(fails('{"colour":"blue"}').message).toMatch(/colour|additional/);
    expect(fails("mode: [").reason).toBe("CONFIG_INVALID");
    expect(fails("- a\n- b\n").reason).toBe("CONFIG_INVALID");
  });

  it("TestPlan_override_below_minimum: an override may only lengthen retention.min", () => {
    const ok = parseDataLifecycle({ tables: { widgets: { retention: { min: "15y after closed" } } } }, decl);
    expect(ok.tables.widgets!.retention!.min).toBe("15y after closed");
    const e = fails({ tables: { widgets: { retention: { min: "5y after closed" } } } });
    expect(e.message).toContain("widgets");
    expect(e.message).toContain("10y after closed");
    expect(fails({ tables: { widgets: { retention: { min: "20y after created" } } } }).message).toContain("anchor");
    // a table without a declared minimum takes any override
    expect(parseDataLifecycle({ tables: { widget_kinds: { retention: { min: "1y after created" } } } }, decl).tables.widget_kinds).toBeDefined();
  });

  it("an override of an undeclared table, or one that breaks an invariant, fails", () => {
    expect(fails({ tables: { nope: { tiers: { hot: "30d" } } } }).message).toContain("nope");
    expect(fails({ tables: { widget_jobs: { tiers: { cold: "1y after created" } } } }).message).toContain("widget_jobs");
    expect(fails({ tables: { owner_snapshots: { retention: { min: "1y after created" } } } }).message).toContain("owner_snapshots");
  });
});

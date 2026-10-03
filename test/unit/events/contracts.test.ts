import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventContracts } from "../../../src/events/contracts.js";

const dir = fileURLToPath(new URL("../../fixtures/basic/contracts", import.meta.url));

describe("EventContracts (P12.2)", () => {
  const c = EventContracts.load(dir);
  it("knows each subject's aggregate type, file and whether it is a transaction document", () => {
    expect(c.get("sdktest.basic.thing.created.v1")).toMatchObject({ aggregateType: "sdktest.basic.thing", file: "basic.events.json", transactionDocument: true });
    expect(c.get("sdktest.basic.thing.renamed.v1")?.transactionDocument).toBe(false);
    expect(c.get("nope.x.y.v1")).toBeUndefined();
  });
  it("validates a payload against the contract", () => {
    const e = c.get("sdktest.basic.thing.created.v1")!;
    expect(e.check({ thing_id: "t", legal_entity_id: "LE01", amount: "1.50" })).toEqual([]);
    expect(e.check({ thing_id: "t", amount: 1.5 }).length).toBeGreaterThan(0);
  });
  it("refuses a payload above 64 KiB (stage-B ruling: larger content goes by claim check)", () => {
    const e = c.get("sdktest.basic.thing.created.v1")!;
    const base = { thing_id: "t", legal_entity_id: "LE01", amount: "1", note: "" };
    const fill = (64 << 10) - Buffer.byteLength(JSON.stringify(base));
    expect(e.check({ ...base, note: "x".repeat(fill) })).toEqual([]);
    expect(e.check({ ...base, note: "x".repeat(fill + 1) })).toEqual(["payload exceeds 64 KiB; send a claim check (P12.2)"]);
  });
  it("loads an empty set when there is no contracts directory", () => {
    expect(EventContracts.load(undefined).get("a.b.c.v1")).toBeUndefined();
  });
});

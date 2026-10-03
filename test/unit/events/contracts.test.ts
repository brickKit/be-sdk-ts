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
  it("refuses a payload above 1 MiB", () => {
    const e = c.get("sdktest.basic.thing.created.v1")!;
    expect(e.check({ thing_id: "t", legal_entity_id: "LE01", amount: "1", note: "x".repeat(1 << 20) })).toEqual(["payload exceeds 1 MiB"]);
  });
  it("loads an empty set when there is no contracts directory", () => {
    expect(EventContracts.load(undefined).get("a.b.c.v1")).toBeUndefined();
  });
});

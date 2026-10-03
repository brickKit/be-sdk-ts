// Which aggregate type a consumer checks (stage-B ruling): the subscription's own declaration, else the
// producer's contract when the consumer ships it, else "" — then the consumer falls back to ce-aggregatetype.
import { describe, expect, it } from "vitest";
import { subscriptionInfo } from "../../../src/events/runtime.js";

describe("subscriptionInfo", () => {
  const contract = { aggregateType: "erp.sales.order", transactionDocument: true };
  it("prefers the subscription's declared aggregate type", () => {
    expect(subscriptionInfo("crm/x", { subject: "erp.sales.order.created.v1", aggregateType: "erp.sales.order", transactionDocument: true }, undefined))
      .toEqual({ componentId: "crm/x", subject: "erp.sales.order.created.v1", aggregateType: "erp.sales.order", transactionDocument: true });
  });
  it("falls back to the contract, then to empty (header fallback at receipt)", () => {
    expect(subscriptionInfo("crm/x", { subject: "s.a.b.v1" }, contract)).toMatchObject({ aggregateType: "erp.sales.order", transactionDocument: true });
    expect(subscriptionInfo("crm/x", { subject: "s.a.b.v1" }, undefined)).toMatchObject({ aggregateType: "", transactionDocument: false });
  });
});

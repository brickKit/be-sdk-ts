// P16.4, P16.8: the `_lifecycle` resource contract table.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isBeError } from "../../../src/errors/beError.js";
import type { LifecycleEngine } from "../../../src/lifecycle/engine.js";
import { LIFECYCLE_ROUTES, permissionKey } from "../../../src/lifecycle/routes.js";

// operationId → [method, OpenAPI path, x-be-permission suffix], from openapi/resource-lifecycle.yaml
const CONTRACT: Record<string, [string, string, string]> = {
  listUnits: ["GET", "/{domain}/{name}/_lifecycle/units", "read"],
  thawUnit: ["POST", "/{domain}/{name}/_lifecycle/units/{table}/{unit}:thaw", "thaw"],
  verify: ["GET", "/{domain}/{name}/_lifecycle/verify", "read"],
  createExport: ["POST", "/{domain}/{name}/_lifecycle/exports", "read"],
  getExport: ["GET", "/{domain}/{name}/_lifecycle/exports/{job_id}", "read"],
  listHolds: ["GET", "/{domain}/{name}/_lifecycle/holds", "admin"],
  placeHold: ["POST", "/{domain}/{name}/_lifecycle/holds", "admin"],
  releaseHold: ["DELETE", "/{domain}/{name}/_lifecycle/holds/{hold_id}", "admin"],
  requestErasure: ["POST", "/{domain}/{name}/_lifecycle/erasures", "admin"],
  getErasure: ["GET", "/{domain}/{name}/_lifecycle/erasures/{request_id}", "admin"],
  listDestructions: ["GET", "/{domain}/{name}/_lifecycle/destructions", "admin"],
  approveDestruction: ["POST", "/{domain}/{name}/_lifecycle/destructions/{destruction_id}:approve", "admin"],
};

describe("_lifecycle routes", () => {
  it("mounts every operation of the contract with its permission", () => {
    expect(LIFECYCLE_ROUTES.map((r) => r.operationId).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const r of LIFECYCLE_ROUTES) expect([r.method, r.openapiPath, r.permission]).toEqual(CONTRACT[r.operationId]);
  });

  it("permission keys are <domain>.<name>.lifecycle.<read|thaw|admin>", () => {
    expect(permissionKey("erp/sales", "read")).toBe("erp.sales.lifecycle.read");
    expect(permissionKey("infra/iam-casdoor", "admin")).toBe("infra.iam-casdoor.lifecycle.admin");
  });

  it("an operation not implemented yet answers 501 CAPABILITY_UNAVAILABLE naming the capability", async () => {
    for (const id of ["thawUnit", "createExport", "getExport", "requestErasure", "getErasure", "listDestructions", "approveDestruction"]) {
      const r = LIFECYCLE_ROUTES.find((x) => x.operationId === id)!;
      const e = await r.handler({} as LifecycleEngine, { params: {}, query: {}, actor: "u1" }).catch((x: unknown) => x);
      expect(isBeError(e) && e.reason).toBe("CAPABILITY_UNAVAILABLE");
      expect(isBeError(e) && e.code).toBe("UNIMPLEMENTED");
      expect(isBeError(e) && e.metadata.capability).toMatch(/^lifecycle\./);
    }
  });

  it("Fastify routes the custom-method paths (a literal colon) and the plain ones", async () => {
    const app = Fastify();
    for (const r of LIFECYCLE_ROUTES) app.route({ method: r.method, url: `/erp/sales${r.path}`, handler: async (req) => ({ op: r.operationId, params: req.params }) });
    const hit = async (method: "GET" | "POST" | "DELETE", url: string) => (await app.inject({ method, url })).json();
    expect(await hit("POST", "/erp/sales/_lifecycle/units/widgets/widgets_p20261001:thaw")).toEqual({ op: "thawUnit", params: { table: "widgets", unit: "widgets_p20261001" } });
    expect(await hit("POST", "/erp/sales/_lifecycle/destructions/d1:approve")).toEqual({ op: "approveDestruction", params: { destruction_id: "d1" } });
    expect((await hit("DELETE", "/erp/sales/_lifecycle/holds/h1")).op).toBe("releaseHold");
    expect((await hit("GET", "/erp/sales/_lifecycle/units?table=widgets")).op).toBe("listUnits");
    await app.close();
  });
});

// The resource contract /{domain}/{name}/_lifecycle/* (P16.4, openapi/resource-lifecycle.yaml) as plain handlers,
// one row per operation with its permission key (P16.8), so the runtime mounts them mechanically on its Router
// (paths are relative to the member prefix, in Fastify syntax: `::` is a literal colon, and the parameter before
// it is bounded by a pattern). Implemented in this SDK release: units, verify, holds. Every other operation answers
// 501 CAPABILITY_UNAVAILABLE with metadata.capability (thaw and exports need a cold store; erasures and
// destructions come later).
import { BeError, platformError } from "../errors/beError.js";
import { queryOf } from "./context.js";
import type { LifecycleEngine } from "./engine.js";
import { listHolds, listUnits, placeHold, releaseHold } from "./resource.js";

export interface LifecycleRequest {
  /** path parameters: table, unit, job_id, hold_id, request_id, destruction_id */
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body?: unknown;
  /** the caller's subject (`sub`), recorded as placed_by and in besdk_lifecycle_log */
  actor: string;
}

export interface LifecycleResponse {
  status: number;
  body: unknown;
}

export type LifecycleHandler = (engine: LifecycleEngine, req: LifecycleRequest) => Promise<LifecycleResponse>;
export type LifecyclePermission = "read" | "thaw" | "admin";

export interface LifecycleRoute {
  operationId: string;
  method: "GET" | "POST" | "DELETE";
  /** relative to the member prefix /{domain}/{name}, Fastify syntax */
  path: string;
  /** the operation's path in openapi/resource-lifecycle.yaml */
  openapiPath: string;
  permission: LifecyclePermission;
  handler: LifecycleHandler;
}

/** `<domain>.<name>.lifecycle.<read|thaw|admin>` (P16.8). */
export function permissionKey(memberId: string, p: LifecyclePermission): string {
  return `${memberId.replace("/", ".")}.lifecycle.${p}`;
}

const unavailable = (capability: string): LifecycleHandler => async () => {
  throw platformError("CAPABILITY_UNAVAILABLE", { capability }, `${capability} is not available in this SDK release (cold store none)`);
};

function invalid(field: string, description: string): BeError {
  return new BeError("INVALID_ARGUMENT", "REQUEST_INVALID", { domain: "be", message: `${field}: ${description}`, violations: [{ field, reason: "INVALID", description }] });
}

function requiredTable(engine: LifecycleEngine, q: Record<string, string | undefined>): string {
  const table = q.table;
  if (!table) throw invalid("table", "required");
  engine.table(table);
  return table;
}

function pageSize(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw invalid("page_size", "an integer from 1 to 500");
  return n;
}

const units: LifecycleHandler = async (engine, req) => {
  const table = requiredTable(engine, req.query);
  const size = pageSize(req.query.page_size);
  const body = await engine.store.tx((tx) => listUnits(queryOf(tx), table, size, req.query.cursor || undefined), { readOnly: true });
  return { status: 200, body };
};

const verify: LifecycleHandler = async (engine, req) => ({ status: 200, body: await engine.verify(requiredTable(engine, req.query)) });

const holds: LifecycleHandler = async (engine) => ({
  status: 200, body: { holds: await engine.store.tx((tx) => listHolds(queryOf(tx)), { readOnly: true }) },
});

const place: LifecycleHandler = async (engine, req) => {
  const b = (req.body ?? {}) as { scope?: unknown; reason?: unknown };
  if (typeof b !== "object" || Array.isArray(b)) throw invalid("body", "a JSON object");
  return { status: 200, body: await engine.store.tx((tx) => placeHold(engine.ctx, queryOf(tx), b.scope, b.reason, req.actor)) };
};

const release: LifecycleHandler = async (engine, req) => ({
  status: 200, body: await engine.store.tx((tx) => releaseHold(queryOf(tx), req.params.hold_id ?? "", req.actor)),
});

const P = "/_lifecycle";
const O = "/{domain}/{name}/_lifecycle";

export const LIFECYCLE_ROUTES: readonly LifecycleRoute[] = [
  { operationId: "listUnits", method: "GET", path: `${P}/units`, openapiPath: `${O}/units`, permission: "read", handler: units },
  { operationId: "thawUnit", method: "POST", path: `${P}/units/:table/:unit(^[^:/]+)::thaw`, openapiPath: `${O}/units/{table}/{unit}:thaw`, permission: "thaw", handler: unavailable("lifecycle.thaw") },
  { operationId: "verify", method: "GET", path: `${P}/verify`, openapiPath: `${O}/verify`, permission: "read", handler: verify },
  { operationId: "createExport", method: "POST", path: `${P}/exports`, openapiPath: `${O}/exports`, permission: "read", handler: unavailable("lifecycle.exports") },
  { operationId: "getExport", method: "GET", path: `${P}/exports/:job_id`, openapiPath: `${O}/exports/{job_id}`, permission: "read", handler: unavailable("lifecycle.exports") },
  { operationId: "listHolds", method: "GET", path: `${P}/holds`, openapiPath: `${O}/holds`, permission: "admin", handler: holds },
  { operationId: "placeHold", method: "POST", path: `${P}/holds`, openapiPath: `${O}/holds`, permission: "admin", handler: place },
  { operationId: "releaseHold", method: "DELETE", path: `${P}/holds/:hold_id`, openapiPath: `${O}/holds/{hold_id}`, permission: "admin", handler: release },
  { operationId: "requestErasure", method: "POST", path: `${P}/erasures`, openapiPath: `${O}/erasures`, permission: "admin", handler: unavailable("lifecycle.erasures") },
  { operationId: "getErasure", method: "GET", path: `${P}/erasures/:request_id`, openapiPath: `${O}/erasures/{request_id}`, permission: "admin", handler: unavailable("lifecycle.erasures") },
  { operationId: "listDestructions", method: "GET", path: `${P}/destructions`, openapiPath: `${O}/destructions`, permission: "admin", handler: unavailable("lifecycle.destructions") },
  { operationId: "approveDestruction", method: "POST", path: `${P}/destructions/:destruction_id(^[^:/]+)::approve`, openapiPath: `${O}/destructions/{destruction_id}:approve`, permission: "admin", handler: unavailable("lifecycle.destructions") },
];

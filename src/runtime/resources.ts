// The resource contract of a component that declares resource types (P6.10, openapi/resource-authz.yaml):
// POST _authz/check (≤ 500), GET _authz/explain, and the _shares endpoints; plus the projection's job
// `be.authz.changes` (P6.12). Records are read through the module's `records` loaders.
import type { Logger } from "pino";
import { AUTHENTICATED } from "../auth/guard.js";
import { access } from "../auth/access.js";
import type { Decision, ResourceType, Row } from "../auth/evaluate.js";
import { aclOf, Projection } from "../auth/projection.js";
import { platformError } from "../errors/beError.js";
import type { Router } from "../http/router.js";
import type { Job } from "../jobs/types.js";
import type { Store } from "../store/store.js";
import type { Tx } from "../store/tx.js";

export const MAX_CHECKS = 500;
const PULL_EVERY_MS = 5_000;

/** Reads one record of a type for a decision: id, owner, dept_path and the dimension values; undefined when absent. */
export type RecordLoader = (tx: Tx, id: string) => Promise<Row | undefined>;

interface Check {
  key: string;
  type: string;
  id: string;
}

const NOT_FOUND: Decision = { visible: false, allowed: false, reason: "NOT_FOUND" };

/** The projection of the declared types and the types they inherit from (P6.12). */
export function projectionFor(store: Store, authzUrl: string, types: readonly ResourceType[], logger: Logger): Projection {
  const names = types.flatMap((t) => [t.type, ...(t.inherits ?? []).map((i) => i.from)]);
  return new Projection({ store, authzUrl, types: names, logger });
}

export function projectionJob(p: Projection): Job {
  return { name: "be.authz.changes", kind: "singleton", intervalMs: PULL_EVERY_MS, timeoutMs: 30_000, run: () => p.pull() };
}

export function mountResourceContract(router: Router, store: Store, types: readonly ResourceType[], records: Record<string, RecordLoader>): void {
  const byType = new Map(types.map((t) => [t.type, t]));
  const decide = async (tx: Tx, c: Check): Promise<Decision> => {
    const t = byType.get(c.type);
    const load = records[c.type];
    if (!t || !load) return NOT_FOUND;
    const row = await load(tx, c.id);
    return row ? access().can(c.key, t, row, await aclOf(tx, t.type, row.id)) : NOT_FOUND;
  };
  router.post("/_authz/check", AUTHENTICATED, async (req) => {
    const checks = (req.body as { checks?: Check[] } | undefined)?.checks;
    if (!Array.isArray(checks)) throw platformError("REQUEST_INVALID", undefined, "checks: required");
    if (checks.length > MAX_CHECKS) throw platformError("BATCH_TOO_LARGE", { field: "checks", max: String(MAX_CHECKS), got: String(checks.length) });
    const results = await store.readSnapshot(async (tx) => {
      const out: Decision[] = [];
      for (const c of checks) out.push(await decide(tx, c));
      return out;
    });
    return { results: results.map((d) => ({ visible: d.visible, allowed: d.allowed, reason: d.reason })) };
  });
  router.get("/_authz/explain", AUTHENTICATED, async (req) => {
    const q = req.query as Partial<Check>;
    if (!q.key || !q.type || !q.id) throw platformError("REQUEST_INVALID", undefined, "key, type and id are required");
    const t = byType.get(q.type);
    const load = records[q.type];
    if (!t || !load) throw platformError("NOT_FOUND");
    return store.readSnapshot(async (tx) => {
      const row = await load(tx, q.id!);
      if (!row) throw platformError("NOT_FOUND");
      const e = access().explain(q.key!, t, row, await aclOf(tx, t.type, row.id));
      return { decision: e.decision.allowed ? "allowed" : e.decision.visible ? "visible" : "not_visible", reasons: e.reasons, missing: e.missing };
    });
  });
  // sharing needs the provider's WriteTuples client (be-sdk-ts 0.6.0 has none yet): the contract answers 501
  const sharing = async () => {
    throw platformError("CAPABILITY_UNAVAILABLE", { capability: "sharing" }, "shares are not available in this SDK release");
  };
  router.get("/_shares/:type/:id", AUTHENTICATED, sharing);
  router.post("/_shares/:type/:id", AUTHENTICATED, sharing);
  router.delete("/_shares/:type/:id/:share_id", AUTHENTICATED, sharing);
}

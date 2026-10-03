// The lifecycle engine (P16) in a member: loaded from migrations/lifecycle.yaml and DATA_LIFECYCLE, run as the
// singleton job `be.lifecycle`, its events written through the outbox (P16.7), its resource contract mounted on the
// member's router (P16.4, P16.8), tx.seal delegated to it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { access } from "../auth/access.js";
import type { Config } from "../config/config.js";
import { insertOutbox } from "../events/outbox.js";
import type { Router } from "../http/router.js";
import type { Job } from "../jobs/types.js";
import { DECLARATION_FILE, LIFECYCLE_ROUTES, LifecycleDeclarationError, LifecycleEngine, permissionKey } from "../lifecycle/index.js";
import type { Store } from "../store/store.js";

const ROUND_EVERY_MS = 3_600_000;
const ROUND_TIMEOUT_MS = 15 * 60_000;

export interface LifecycleWiring {
  memberId: string;
  store: Store;
  logger: Logger;
  config: Config;
  migrationsDir: string | undefined;
  /** the member has a bus: lifecycle events go through the outbox, else they are only logged */
  outbox: boolean;
}

/** The engine when the component ships a lifecycle.yaml; a violation throws (exit 78). */
export function loadLifecycle(w: LifecycleWiring): LifecycleEngine | undefined {
  if (!w.migrationsDir || !existsSync(join(w.migrationsDir, DECLARATION_FILE))) return undefined;
  return LifecycleEngine.load({
    memberId: w.memberId, store: w.store, logger: w.logger, migrationsDir: w.migrationsDir,
    dataLifecycle: w.config.orDefault("DATA_LIFECYCLE", (c) => c.json<object>("DATA_LIFECYCLE"), undefined),
    emit: w.outbox
      ? (tx, subject, payload) => insertOutbox(tx, {
          subject, aggregateType: "be.lifecycle.unit", aggregateId: `${payload.table}/${payload.unit_key}`,
          version: BigInt(Date.now()), payloadJson: JSON.stringify(payload),
        })
      : async (_tx, subject, payload) => w.logger.info({ subject, payload }, "lifecycle_event_not_published"),
  });
}

/** `be.lifecycle`: the schema checks once (a violation is fatal, P16.1), then one round per hour. */
export function lifecycleJob(engine: LifecycleEngine, fatal: (why: string) => void): Job {
  let checked = false;
  return {
    name: "be.lifecycle", kind: "singleton", intervalMs: ROUND_EVERY_MS, timeoutMs: ROUND_TIMEOUT_MS,
    run: async (signal) => {
      if (!checked) {
        try {
          await engine.checkSchema();
        } catch (e) {
          if (e instanceof LifecycleDeclarationError) fatal(e.message);
          throw e;
        }
        checked = true;
      }
      await engine.runOnce(signal);
    },
  };
}

/** The resource contract /{d}/{n}/_lifecycle/* with the three keys; the response is the handler's status and body. */
export function mountLifecycle(router: Router, memberId: string, engine: LifecycleEngine): void {
  for (const r of LIFECYCLE_ROUTES) {
    const add = r.method === "GET" ? router.get : r.method === "POST" ? router.post : router.delete;
    add.call(router, r.path, permissionKey(memberId, r.permission), async (req, reply) => {
      const res = await r.handler(engine, {
        params: req.params as Record<string, string>, query: req.query as Record<string, string | undefined>, body: req.body, actor: access().user().sub,
      });
      return reply.code(res.status).send(res.body);
    });
  }
}

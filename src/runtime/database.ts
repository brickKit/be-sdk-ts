// The member's database at serve time (P10.7, P1.4, P1.8): the start-up probe and the migration check run in
// the background and gate /readyz; a missing capability or a schema newer than the image is fatal.
import { existsSync, readdirSync } from "node:fs";
import type { Logger } from "pino";
import { errorFields } from "../log/logger.js";
import { PLATFORM_VERSION } from "../migrate/run.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { migrationVersions, probeDatabase } from "../store/probe.js";
import type { Store } from "../store/store.js";
import { sleep } from "../util/sleep.js";
import type { Readiness } from "./readiness.js";

export interface DatabaseCheckDeps {
  store: Store;
  ownerRole: string;
  migrationsDir: string | undefined;
  shell: boolean;
  logger: Logger;
  metrics: MemberRegistry;
  readiness: Readiness;
  fatal: (why: string) => void;
  /** the schema's versions for /_be/info */
  report?: (component: string | null, platform: number | null) => void;
}

/** Migration names in the image's directory, the way node-pg-migrate names them (file name without .sql). */
export function imageMigrations(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)).sort();
}

/** Compares the schema with the image: "ahead" is fatal on the serve entry point, "behind" keeps /readyz 503. */
export function compareMigrations(applied: string[], image: string[], platform: number | undefined): "ok" | "behind" | "ahead" {
  if (applied.some((a) => !image.includes(a)) || (platform ?? 0) > PLATFORM_VERSION) return "ahead";
  if (image.some((m) => !applied.includes(m)) || (platform ?? 0) < PLATFORM_VERSION) return "behind";
  return "ok";
}

/** The supervised task `be.db.probe`: retries until the identity and the migrations are right, then returns. */
export async function checkDatabase(d: DatabaseCheckDeps, signal: AbortSignal): Promise<void> {
  const image = imageMigrations(d.migrationsDir);
  let identityDone = false;
  let wait = 500;
  while (!signal.aborted) {
    try {
      if (!identityDone) {
        const p = await probeDatabase(d.store, { ownerRole: d.ownerRole, shell: d.shell, metrics: d.metrics, logger: d.logger });
        if (!p.capabilitiesOk) return d.fatal(p.problems.join("; "));
        if (p.identityOk) {
          identityDone = true;
          d.readiness.met("db_identity");
        }
      }
      const v = await migrationVersions(d.store);
      d.report?.(v.component ?? null, v.platform ?? null);
      const state = compareMigrations(v.applied, image, v.platform);
      if (state === "ahead") return d.fatal(`the schema's migrations (${v.component ?? "none"}, platform ${v.platform ?? 0}) are newer than this image's`);
      if (state === "ok") d.readiness.met("migrations");
      if (identityDone && state === "ok") return;
    } catch (e) {
      d.logger.warn(errorFields(e), "database_not_ready");
    }
    await sleep(wait, signal);
    wait = Math.min(wait * 2, 15_000);
  }
}

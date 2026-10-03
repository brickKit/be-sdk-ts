// The process entry point (P1.1, P1.2, P1.8, P14.8): `main(spec)` dispatches on argv — serve (no argument),
// `migrate up|down <n>|status`, `job run <name>` — and is the only place that reads the process environment
// and exits. `runMain` is the same without the process, for tests and for the shell launcher.
import { resolve } from "node:path";
import { Config } from "../config/config.js";
import { ConfigError, ConfigErrors } from "../config/configError.js";
import { readManifest, type Manifest } from "../config/manifest.js";
import { errorFields, newLogger, nowRfc3339Nano } from "../log/logger.js";
import { ensureEventsAtMigrate } from "../events/migrateStep.js";
import { runMigrations } from "../migrate/run.js";
import { Member } from "./member.js";
import { Platform } from "./platform.js";
import type { Spec } from "./spec.js";

export interface MainIO {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(s: string): unknown };
}

export interface ServeHandle {
  baseUrl: string;
  member: Member;
  stop(): Promise<void>;
  /** settles when background work found a fatal condition (P1.8): the process exits non-zero */
  fatal: Promise<string>;
}

export type MainResult = { exitCode: number } | { handle: ServeHandle };

export const EXIT = { OK: 0, FAILED: 1, USAGE: 64, CONFIG: 78 } as const;

type Command = { kind: "serve" } | { kind: "migrate"; direction: "up" | "down" | "status"; count?: number } | { kind: "job"; name: string };

export function parseArgs(argv: string[]): Command | undefined {
  if (argv.length === 0) return { kind: "serve" };
  if (argv[0] === "migrate") {
    if (argv.length === 2 && (argv[1] === "up" || argv[1] === "status")) return { kind: "migrate", direction: argv[1] };
    if (argv.length === 3 && argv[1] === "down" && /^[1-9][0-9]*$/.test(argv[2]!)) return { kind: "migrate", direction: "down", count: Number(argv[2]) };
    return undefined;
  }
  if (argv[0] === "job" && argv[1] === "run" && argv.length === 3 && argv[2]) return { kind: "job", name: argv[2] };
  return undefined;
}

function line(io: MainIO, fields: Record<string, unknown>): void {
  io.stdout.write(JSON.stringify({ time: nowRfc3339Nano(), level: "error", ...fields }) + "\n");
}

/** Configuration of the process: the manifest, then every key validated at once (exit 78 on any problem). */
function loadConfig(spec: Spec, io: MainIO, unreadSecrets: string[]): { manifest: Manifest; config: Config } | undefined {
  const manifest = readManifest(resolve(spec.manifest ?? "component.yaml"));
  const id = io.env.COMPONENT_ID;
  if ((id !== undefined && id !== spec.id) || (manifest.id !== "" && manifest.id !== spec.id)) {
    line(io, { msg: "config_invalid", component_id: spec.id, key: "COMPONENT_ID", reason: "CONFIG_INVALID", error: `COMPONENT_ID ${id} / component.yaml ${manifest.id} differ from ${spec.id}` });
    return undefined;
  }
  try {
    return { manifest, config: Config.load(manifest, io.env, { unreadSecrets }) };
  } catch (e) {
    if (!(e instanceof ConfigErrors)) throw e;
    for (const x of e.errors) line(io, { msg: "config_invalid", component_id: spec.id, key: x.key, reason: x.reason, error: x.message });
    return undefined;
  }
}

export async function runMain(spec: Spec, io: MainIO): Promise<MainResult> {
  const cmd = parseArgs(io.argv);
  if (!cmd) {
    line(io, { msg: "usage", component_id: spec.id, error: `unknown arguments: ${io.argv.join(" ")}; expected none, migrate up|down <n>|status, or job run <name>` });
    return { exitCode: EXIT.USAGE };
  }
  // P10.12: only the migrate entry point opens the owner's password file
  const loaded = loadConfig(spec, io, cmd.kind === "migrate" ? [] : ["PG_OWNER_PASSWORD_FILE"]);
  if (!loaded) return { exitCode: EXIT.CONFIG };
  const { manifest, config } = loaded;
  const version = io.env.COMPONENT_VERSION ?? manifest.version;
  const logger = newLogger({ componentId: spec.id, componentVersion: version, level: config.orDefault("LOG_LEVEL", (c) => c.string("LOG_LEVEL", "info")!, "info") as "info", destination: io.stdout });
  if (cmd.kind === "migrate") return migrate(spec, manifest, config, logger, cmd);
  const platform = new Platform(config, logger);
  const member = new Member({ spec, manifest, config, version, logger, platform });
  if (cmd.kind === "job") return { exitCode: await member.runJob(cmd.name).catch((e) => exitFor(e, logger)) };
  let fatal!: (why: string) => void;
  const fatalP = new Promise<string>((r) => (fatal = r));
  member.onFatal = (why) => {
    logger.error({ error: why }, "fatal");
    fatal(why);
  };
  try {
    await member.init();
  } catch (e) {
    const exitCode = exitFor(e, logger);
    await member.stop().catch(() => {});
    await platform.shutdown();
    return { exitCode };
  }
  const baseUrl = await member.listen();
  logger.info({ url: baseUrl }, "serving");
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= member.stop().then(() => platform.shutdown()));
  return { handle: { baseUrl, member, stop, fatal: fatalP } };
}

/** A configuration problem found while building the member (a schedule, JOBS_OVERRIDES) exits 78, anything else 1. */
function exitFor(e: unknown, logger: ReturnType<typeof newLogger>): number {
  if (e instanceof ConfigError) {
    logger.error({ key: e.key, reason: e.reason, error: e.message }, "config_invalid");
    return EXIT.CONFIG;
  }
  logger.error(errorFields(e), "init_failed");
  return EXIT.FAILED;
}

async function migrate(spec: Spec, manifest: Manifest, config: Config, logger: ReturnType<typeof newLogger>, cmd: { direction: "up" | "down" | "status"; count?: number }): Promise<MainResult> {
  if (!spec.migrations) {
    logger.info("this component has no migrations directory");
    return { exitCode: EXIT.OK };
  }
  try {
    const r = await runMigrations({
      memberId: spec.id, config, logger, migrationsDir: resolve(spec.migrations), direction: cmd.direction, count: cmd.count,
      afterPlatform: () => ensureEventsAtMigrate(spec.id, manifest, config, logger),
    });
    // P1.8: a schema newer than the image is a WARN on the migrate entry point, so a rollback is not blocked
    if (r.status === "ahead") logger.warn({ unknown: r.unknown }, "schema_ahead_of_image");
    return { exitCode: EXIT.OK };
  } catch (e) {
    logger.error(errorFields(e), "migration_failed");
    return { exitCode: EXIT.FAILED };
  }
}

/** The component's `main`: `main(defineComponent({...}))`. Never returns. */
export function main(spec: Spec): void {
  void runMain(spec, { argv: process.argv.slice(2), env: { ...process.env }, stdout: process.stdout }).then(
    (r) => {
      if ("exitCode" in r) return process.exit(r.exitCode);
      const onSignal = () => void r.handle.stop().then(() => process.exit(EXIT.OK), () => process.exit(EXIT.FAILED));
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      void r.handle.fatal.then(() => r.handle.stop().finally(() => process.exit(EXIT.FAILED)));
    },
    (e) => {
      process.stdout.write(JSON.stringify({ time: nowRfc3339Nano(), level: "error", msg: "fatal", component_id: spec.id, ...errorFields(e) }) + "\n");
      process.exit(EXIT.FAILED);
    },
  );
}

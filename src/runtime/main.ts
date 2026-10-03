// The process entry point (P1.1, P1.2, P1.8, P14.8): `main(spec)` dispatches on argv — serve (no argument),
// `migrate up|down <n>|status`, `job run <name>` — and is the only place that reads the process environment
// and exits. `runMain` is the same without the process, for tests and for the shell launcher.
import { resolve } from "node:path";
import { Config } from "../config/config.js";
import { ConfigErrors } from "../config/configError.js";
import { readManifest, type Manifest } from "../config/manifest.js";
import { errorFields, newLogger, nowRfc3339Nano } from "../log/logger.js";
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
function loadConfig(spec: Spec, io: MainIO): { manifest: Manifest; config: Config } | undefined {
  const manifest = readManifest(resolve(spec.manifest ?? "component.yaml"));
  const id = io.env.COMPONENT_ID;
  if ((id !== undefined && id !== spec.id) || (manifest.id !== "" && manifest.id !== spec.id)) {
    line(io, { msg: "config_invalid", component_id: spec.id, key: "COMPONENT_ID", reason: "CONFIG_INVALID", error: `COMPONENT_ID ${id} / component.yaml ${manifest.id} differ from ${spec.id}` });
    return undefined;
  }
  try {
    return { manifest, config: Config.load(manifest, io.env) };
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
  const loaded = loadConfig(spec, io);
  if (!loaded) return { exitCode: EXIT.CONFIG };
  const { manifest, config } = loaded;
  const version = io.env.COMPONENT_VERSION ?? manifest.version;
  const logger = newLogger({ componentId: spec.id, componentVersion: version, level: (config.string("LOG_LEVEL", "info") ?? "info") as "info", destination: io.stdout });
  if (cmd.kind === "job") {
    // P14.8 is optional; jobs arrive with T5 — until then no job name is known
    logger.error({ job: cmd.name }, "job_unknown");
    return { exitCode: EXIT.USAGE };
  }
  if (cmd.kind === "migrate") {
    logger.error({ direction: cmd.direction }, "migrate_unavailable");
    return { exitCode: EXIT.FAILED };
  }
  const platform = new Platform(config, logger);
  const member = new Member({ spec, manifest, config, version, logger, platform });
  try {
    await member.init();
  } catch (e) {
    logger.error(errorFields(e), "init_failed");
    await member.stop().catch(() => {});
    await platform.shutdown();
    return { exitCode: EXIT.FAILED };
  }
  const baseUrl = await member.listen();
  logger.info({ url: baseUrl }, "serving");
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= member.stop().then(() => platform.shutdown()));
  return { handle: { baseUrl, member, stop } };
}

/** The component's `main`: `main(defineComponent({...}))`. Never returns. */
export function main(spec: Spec): void {
  void runMain(spec, { argv: process.argv.slice(2), env: { ...process.env }, stdout: process.stdout }).then(
    (r) => {
      if ("exitCode" in r) return process.exit(r.exitCode);
      const onSignal = () => void r.handle.stop().then(() => process.exit(EXIT.OK), () => process.exit(EXIT.FAILED));
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    },
    (e) => {
      process.stdout.write(JSON.stringify({ time: nowRfc3339Nano(), level: "error", msg: "fatal", component_id: spec.id, ...errorFields(e) }) + "\n");
      process.exit(EXIT.FAILED);
    },
  );
}

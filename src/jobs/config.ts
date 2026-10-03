// The jobs' configuration (P14.5, P14.6): JOBS_OVERRIDES (JSON, schemas/jobs-overrides.schema.json) and
// BUSINESS_TIMEZONE (an IANA zone). A bad value is a configuration error (exit 78).
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Config } from "../config/config.js";
import { ConfigError } from "../config/configError.js";
import { protocolPath } from "../protocolFiles.js";
import type { Override } from "./types.js";

let validate: ((v: unknown) => boolean) & { errors?: unknown } | undefined;

export function jobsOverrides(c: Config): Record<string, Override> {
  const v = c.orDefault("JOBS_OVERRIDES", (x) => x.json("JOBS_OVERRIDES"), undefined);
  if (v === undefined || v === null) return {};
  validate ??= new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(protocolPath("schemas/jobs-overrides.schema.json"), "utf8")));
  if (!validate(v)) throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `does not match jobs-overrides.schema.json: ${JSON.stringify(validate.errors)}`);
  return v as Record<string, Override>;
}

export function businessZone(c: Config): string {
  const zone = c.orDefault("BUSINESS_TIMEZONE", (x) => x.string("BUSINESS_TIMEZONE", "Asia/Shanghai"), "Asia/Shanghai") || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ConfigError("CONFIG_INVALID", "BUSINESS_TIMEZONE", `not an IANA zone: ${zone}`);
  }
  return zone;
}

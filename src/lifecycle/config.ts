// DATA_LIFECYCLE (P16.9): the engine's mode, its adapters and the deployment's per-table overrides. A JSON object
// or a YAML mapping read with the YAML 1.2 core schema. This SDK release implements the `none` cold store, cold
// query and publisher, the `plain` pii protector and the `pg-native` dialect; any other adapter fails the start
// naming it. An override may only lengthen retention.min. Every problem is a ConfigError (exit 78).
import { ConfigError } from "../config/configError.js";
import { SDK_NAME, SDK_VERSION } from "../protocolFiles.js";
import { compareMin } from "./duration.js";
import { effectiveTables } from "./declaration.js";
import { checkConfigSchema, parseYaml12 } from "./schemas.js";
import type { Declaration, LifecycleConfig } from "./types.js";

export const DATA_LIFECYCLE = "DATA_LIFECYCLE";
const IMPLEMENTED: Record<string, string> = { cold_store: "none", cold_query: "none", publisher: "none", pii: "plain" };
const RELEASE = SDK_VERSION.replace(/-.*$/, "");

const bad = (message: string) => new ConfigError("CONFIG_INVALID", DATA_LIFECYCLE, message);

function toObject(raw: string | object | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = parseYaml12(raw);
    } catch (e) {
      throw bad(`neither JSON nor YAML: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad("not an object (a JSON object or a YAML mapping)");
  return v as Record<string, unknown>;
}

function checkAdapters(v: Record<string, unknown>): void {
  for (const [key, have] of Object.entries(IMPLEMENTED)) {
    const want = v[key];
    if (want === undefined || want === have) continue;
    throw bad(`${key} ${JSON.stringify(want)} is not supported by ${SDK_NAME} ${RELEASE} (implemented: ${have})`);
  }
}

type Overrides = LifecycleConfig["tables"];

function checkOverrides(tables: Overrides, decl: Declaration): void {
  const eff = effectiveTables(decl);
  for (const [name, o] of Object.entries(tables)) {
    const t = eff.get(name);
    if (!t) throw bad(`tables.${name}: not a table of lifecycle.yaml`);
    const min = o.retention?.min;
    const declared = t.retention?.min;
    if (min !== undefined && t.class === "snapshot") throw bad(`tables.${name}: a snapshot table takes no retention.min`);
    if (min !== undefined && declared !== undefined) {
      const c = compareMin(min, declared);
      if (c === "incomparable") throw bad(`tables.${name}: retention.min ${min} must use the declared anchor (${declared})`);
      if (c === "shorter") throw bad(`tables.${name}: retention.min ${min} is shorter than the declared minimum ${declared}; an override may only lengthen it`);
    }
    const cold = o.tiers?.cold;
    if (cold !== undefined && cold !== "never" && t.class === "queue") throw bad(`tables.${name}: a queue table takes no tiers.cold`);
  }
}

/** Parses and checks DATA_LIFECYCLE against the component's declaration; throws ConfigError. */
export function parseDataLifecycle(raw: string | object | undefined, decl: Declaration): LifecycleConfig {
  const v = toObject(raw);
  for (const key of Object.keys(IMPLEMENTED)) if (typeof v[key] === "string") checkAdapters({ [key]: v[key] });
  const problems = checkConfigSchema(v);
  if (problems.length > 0) {
    const p = problems[0]!;
    const at = p.path.split("/").filter(Boolean).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], v);
    throw bad(`${p.path} ${p.message}${at === undefined || typeof at === "object" ? "" : ` (${JSON.stringify(at)})`}`);
  }
  checkAdapters(v);
  const tables = (v.tables ?? {}) as Overrides;
  checkOverrides(tables, decl);
  return {
    mode: (v.mode as LifecycleConfig["mode"] | undefined) ?? "on",
    cold_store: "none", cold_query: "none", publisher: "none", pii: "plain", dialect: "pg-native",
    tables,
  };
}

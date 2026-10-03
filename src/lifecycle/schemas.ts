// The protocol's JSON Schemas for lifecycle.yaml and DATA_LIFECYCLE (protocol/schemas), compiled once.
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { protocolPath } from "../protocolFiles.js";

let compiled: { declaration: ValidateFunction; config: ValidateFunction } | undefined;

function validators() {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const read = (f: string) => JSON.parse(readFileSync(protocolPath(`schemas/${f}`), "utf8")) as { $id: string };
  const decl = read("lifecycle.schema.json");
  const cfg = read("data-lifecycle-config.schema.json");
  ajv.addSchema(decl);
  ajv.addSchema(cfg);
  compiled = { declaration: ajv.getSchema(decl.$id)!, config: ajv.getSchema(cfg.$id)! };
  return compiled;
}

export interface SchemaProblem {
  path: string;
  message: string;
}

function check(v: ValidateFunction, value: unknown): SchemaProblem[] {
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
}

export const checkDeclarationSchema = (value: unknown) => check(validators().declaration, value);
export const checkConfigSchema = (value: unknown) => check(validators().config, value);

/** YAML 1.2 core schema (`on` / `off` are strings), duplicate keys refused; JSON is a subset. */
export function parseYaml12(text: string): unknown {
  return parse(text, { version: "1.2", schema: "core", uniqueKeys: true });
}

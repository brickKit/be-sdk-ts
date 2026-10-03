// The parts of the image's component.yaml the runtime reads (P2.2, P20): identity, ports, configSchema,
// dependencies and declared events.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface SchemaItem {
  type?: string;
  default?: unknown;
  secret?: boolean;
  mount?: string;
  enum?: string[];
  minimum?: number;
}

export interface Manifest {
  id: string;
  version: string;
  port: number;
  extraPorts: Record<string, number>;
  properties: Record<string, SchemaItem>;
  required: string[];
  dependencies: { id: string; optional: boolean }[];
  publishes: string[];
  subscribes: string[];
}

export function readManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, "utf8"));
}

export function parseManifest(text: string): Manifest {
  const y = (parse(text) ?? {}) as Record<string, any>;
  const deps = ((y.dependencies?.components ?? []) as unknown[]).map((d) => {
    const ref = typeof d === "string" ? d : String((d as { id: string }).id);
    return { id: ref.split("@")[0]!, optional: typeof d === "object" && d !== null && (d as { optional?: boolean }).optional === true };
  });
  const extra: Record<string, number> = {};
  for (const p of (y.deployment?.extraPorts ?? []) as { name: string; port: number }[]) extra[p.name] = Number(p.port);
  return {
    id: String(y.metadata?.id ?? ""),
    version: String(y.metadata?.version ?? ""),
    port: Number(y.deployment?.port ?? 0),
    extraPorts: extra,
    properties: (y.configSchema?.properties ?? {}) as Record<string, SchemaItem>,
    required: (y.configSchema?.required ?? []) as string[],
    dependencies: deps,
    publishes: (y.events?.publishes ?? []) as string[],
    subscribes: (y.events?.subscribes ?? []) as string[],
  };
}

// GET /_be/info (P20.4): who this process is, what it implements, which ports it serves.
import type { Manifest } from "../config/manifest.js";
import { PROTOCOL_VERSION, SDK_NAME, SDK_VERSION } from "../protocolFiles.js";

export interface InfoState {
  ports: Record<string, number>;
  migrations: { component: string | null; platform: number | null };
  degraded: string[];
  capabilities: string[];
}

/** The profiles this runtime claims, from the manifest's facts (README of be-protocol, "Conformance"). */
export function claimedProfiles(m: Manifest): string[] {
  const p = ["core", "obs", "err"];
  if ("AUTHZ_URL" in m.properties) p.push("auth");
  if ("PG_SCHEMA" in m.properties) p.push("db");
  if ("grpc" in m.extraPorts) p.push("grpc");
  if (m.dependencies.length > 0) p.push("outbound");
  if (m.publishes.length > 0) p.push("events-pub");
  if (m.subscribes.length > 0) p.push("events-sub");
  return p;
}

export function buildInfo(m: Manifest, version: string, s: InfoState): Record<string, unknown> {
  const info: Record<string, unknown> = {
    component_id: m.id,
    component_version: version,
    protocol: PROTOCOL_VERSION,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    language: { name: "node", version: process.versions.node },
    profiles: claimedProfiles(m),
    ports: s.ports,
    migrations: s.migrations,
    members: null,
  };
  if (process.versions.tz) info.tzdata = process.versions.tz;
  if (s.degraded.length > 0) info.degraded = s.degraded;
  if (s.capabilities.length > 0) info.capabilities = s.capabilities;
  return info;
}

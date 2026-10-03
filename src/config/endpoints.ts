// Dependency address variables (P2.5, P2.6) and slot-family addresses (P2.10); vectors config/endpoints.
import { ConfigError } from "./configError.js";

const COMPONENT_ID = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const PORT_NAME = /^[a-z][a-z0-9-]*$/;
const ADDRESS = /^http:\/\/([^\s/:?#]+|\[[0-9A-Fa-f:.]+\]):([0-9]{1,5})\/?$/;

export const FAMILY_KEYS = ["AUTHZ_URL", "AUTHZ_GRPC_URL", "IAM_URL", "IAM_GRPC_URL"] as const;

export function endpointName(dependency: string, port = ""): string {
  if (!COMPONENT_ID.test(dependency)) throw new ConfigError("COMPONENT_INVALID", dependency, "not a component ID");
  if (port !== "" && !PORT_NAME.test(port)) throw new ConfigError("PORT_NAME_INVALID", port, "not a port name");
  const up = (s: string) => s.toUpperCase().replace(/[/-]/g, "_");
  return `${up(dependency)}${port ? `_${up(port)}` : ""}_ENDPOINT`;
}

/** host:port of an injected `*_ENDPOINT` value; undefined when the variable does not exist. */
export function endpointValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return hostPort(key, value);
}

/** `*_URL` → `http://host:port` (REST base); `*_GRPC_URL` → `host:port` (dial target). */
export function familyAddress(key: string, value: string | undefined): string | undefined {
  if (!(FAMILY_KEYS as readonly string[]).includes(key)) throw new ConfigError("CONFIG_KEY_INVALID", key, "not a family address key");
  if (value === undefined) return undefined;
  const hp = hostPort(key, value);
  return key.endsWith("_GRPC_URL") ? hp : `http://${hp}`;
}

function hostPort(key: string, value: string): string {
  const m = ADDRESS.exec(value);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) throw new ConfigError("CONFIG_INVALID", key, `not http://host:port: ${JSON.stringify(value)}`);
  return `${m[1]}:${m[2]}`;
}

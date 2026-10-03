// Files of be-protocol that the runtime ships (protocol/schemas, protocol/ddl), synced at a pinned tag by
// `make sync-protocol`. This module sits at the package's source root, so the same relative path works
// from src/ (tests) and dist/ (the published package).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const PROTOCOL_VERSION = "1.0";
export const SDK_NAME = "be-sdk-ts";
export const SDK_VERSION = "0.6.0";

export function protocolPath(rel: string): string {
  return fileURLToPath(new URL(`../protocol/${rel}`, import.meta.url));
}

export function platformMigrationsPath(): string {
  return fileURLToPath(new URL("../platform-migrations/", import.meta.url));
}

export function readProtocolYaml<T>(rel: string): T {
  return parse(readFileSync(protocolPath(rel), "utf8")) as T;
}

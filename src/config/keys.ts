// Key names a component may declare and how it declares a secret (P2.4, P2.12; vectors config/keys).
import { ConfigError } from "./configError.js";

const KEY = /^[A-Z][A-Z0-9_]*$/;
const RESERVED = new Set(["COMPONENT_ID", "COMPONENT_VERSION", "PORT", "BRICKKIT_SERVED_MEMBERS", "BRICKKIT_SERVED_MEMBERS_CONFIG"]);

export function isPlatformName(key: string): boolean {
  return RESERVED.has(key) || key.endsWith("_ENDPOINT");
}

export function validateKeyName(key: string): void {
  if (!KEY.test(key)) throw new ConfigError("CONFIG_KEY_INVALID", key, "a key is an upper-snake environment variable name");
  if (isPlatformName(key)) throw new ConfigError("CONFIG_KEY_RESERVED", key, "the name belongs to the platform");
}

export function validateKeyDeclaration(key: string, d: { secret?: boolean; mount?: string; type?: string }): void {
  validateKeyName(key);
  if (d.mount !== undefined && d.mount !== "file") throw new ConfigError("MOUNT_INVALID", key, "mount is only `file`");
  if (d.mount === "file" && !d.secret) throw new ConfigError("MOUNT_NEEDS_SECRET", key, "mount: file only with secret: true");
  if (d.mount === "file" && d.type !== undefined && d.type !== "string") throw new ConfigError("MOUNT_NEEDS_STRING", key, "mount: file only on a string");
  if (d.secret && d.mount !== "file") throw new ConfigError("SECRET_NOT_FILE", key, "a secret is delivered as a file (mount: file)");
  if (d.secret && !key.endsWith("_FILE")) throw new ConfigError("FILE_SUFFIX_REQUIRED", key, "a secret key ends in _FILE");
  if (!d.secret && key.endsWith("_FILE")) throw new ConfigError("FILE_SUFFIX_RESERVED", key, "_FILE belongs to file-delivered secrets");
}

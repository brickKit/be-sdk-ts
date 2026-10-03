// Typed parsing of one configuration value (P2.3, P2.7; vectors config/values).
import { ConfigError } from "./configError.js";
import { parseDurationNs } from "./duration.js";
import { hasDuplicateNames } from "./json.js";

/** `format` uses the catalogue's names (int, bool, durations) or the vectors' (integer, boolean, duration_list). */
export interface KeySpec {
  format: string;
  required: boolean;
  secret: boolean;
  default?: string | null;
  minimum?: number;
  schemes?: string[];
  jsonKind?: "object" | "array";
  enum?: string[];
}

export type Parsed = { set: false } | { set: true; value: unknown; secretPath?: string };

const ALIASES: Record<string, string> = { integer: "int", boolean: "bool", duration_list: "durations" };
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^\s/@]+@)?(\[[0-9A-Fa-f:.]+\]|[^\s/:?#[\],@]+)(?::([0-9]+))?([/?#]\S*)?$/;

export function parseValue(key: string, spec: KeySpec, raw: string | undefined): Parsed {
  const format = ALIASES[spec.format] ?? spec.format;
  if (spec.secret) return parseSecretPath(key, spec, raw);
  // P2.3 (rc.2): an empty value counts as not set for every type, strings included; so does an empty default
  if (raw !== undefined && raw !== "") return { set: true, value: convert(key, format, raw, spec) };
  if (spec.default !== undefined && spec.default !== null && spec.default !== "") {
    return { set: true, value: convert(key, format, spec.default, spec) };
  }
  if (spec.required) throw new ConfigError("CONFIG_MISSING", key, "required and not set");
  return { set: false };
}

function parseSecretPath(key: string, spec: KeySpec, raw: string | undefined): Parsed {
  if (raw === undefined || raw === "") {
    if (spec.required) throw new ConfigError("CONFIG_MISSING", key, "required and not set");
    return { set: false };
  }
  if (!raw.startsWith("/") || raw.endsWith("/")) {
    throw new ConfigError("CONFIG_INVALID", key, "a secret key holds the absolute path of its mounted file");
  }
  return { set: true, value: raw, secretPath: raw };
}

function convert(key: string, format: string, raw: string, spec: KeySpec): unknown {
  const bad = (why: string) => new ConfigError("CONFIG_INVALID", key, `${why}: ${JSON.stringify(raw)}`);
  switch (format) {
    case "string":
      return raw;
    case "int": {
      if (!/^-?[0-9]+$/.test(raw)) throw bad("not an integer");
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw bad("integer out of range");
      if (spec.minimum !== undefined && n < spec.minimum) throw bad(`below ${spec.minimum}`);
      return n;
    }
    case "bool":
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw bad("not a boolean");
    case "duration":
      return parseDurationNs(key, raw);
    case "durations": {
      const parts = raw.split(",").map((p) => parseDurationNs(key, p));
      if (parts.some((p) => p <= 0n)) throw bad("every duration must be positive");
      return parts;
    }
    case "url":
      return parseUrl(raw, spec, bad);
    case "json":
      return parseJson(raw, spec, bad);
    case "enum":
      if (!(spec.enum ?? []).includes(raw)) throw bad(`not one of ${(spec.enum ?? []).join(", ")}`);
      return raw;
    case "zone":
      try {
        new Intl.DateTimeFormat("en", { timeZone: raw });
      } catch {
        throw bad("not an IANA time zone");
      }
      if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(raw)) throw bad("not an IANA time zone");
      return raw;
    case "locale":
      try {
        Intl.getCanonicalLocales(raw);
      } catch {
        throw bad("not a BCP 47 language tag");
      }
      return raw;
    default:
      throw bad(`unknown format ${format}`);
  }
}

function parseUrl(raw: string, spec: KeySpec, bad: (w: string) => ConfigError): string {
  const m = URL_RE.exec(raw);
  if (!m) throw bad("not a URL");
  const port = m[4];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw bad("port out of range");
  if (spec.schemes && !spec.schemes.includes(m[1]!)) throw bad(`scheme must be one of ${spec.schemes.join(", ")}`);
  return raw;
}

function parseJson(raw: string, spec: KeySpec, bad: (w: string) => ConfigError): unknown {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (hasDuplicateNames(raw)) throw bad("duplicate member names");
  if (spec.jsonKind === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) throw bad("not a JSON object");
  if (spec.jsonKind === "array" && !Array.isArray(v)) throw bad("not a JSON array");
  return v;
}

/** The text of a secret file: exactly one trailing LF or CRLF removed; empty = not set (P2.9). */
export function secretText(key: string, content: string, required: boolean): string | undefined {
  const v = content.endsWith("\r\n") ? content.slice(0, -2) : content.endsWith("\n") ? content.slice(0, -1) : content;
  if (v === "") {
    if (required) throw new ConfigError("CONFIG_MISSING", key, "the secret file is empty");
    return undefined;
  }
  return v;
}

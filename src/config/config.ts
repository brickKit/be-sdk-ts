// A member's configuration (P2): only the keys its configSchema declares, parsed and validated once at start;
// every problem reported together (exit 78). Reads never fail afterwards, except a read of an undeclared key,
// which is a programming error.
import { ConfigError, ConfigErrors } from "./configError.js";
import { catalogueKey } from "./catalogue.js";
import { endpointName, endpointValue, familyAddress, FAMILY_KEYS } from "./endpoints.js";
import { isPlatformName, validateKeyDeclaration } from "./keys.js";
import type { Manifest, SchemaItem } from "./manifest.js";
import { nsToMs } from "./duration.js";
import { parseValue, type KeySpec } from "./parse.js";
import { Secret } from "./secret.js";

/** P2.2: only declared keys and the platform's reserved names are readable. */
export function checkReadable(key: string, declared: ReadonlySet<string>): void {
  if (!declared.has(key) && !isPlatformName(key)) {
    throw new ConfigError("CONFIG_UNDECLARED", key, "not declared in configSchema");
  }
}

export class Config {
  private readonly declared: ReadonlySet<string>;
  private readonly values = new Map<string, unknown>();
  private readonly secrets = new Map<string, Secret>();
  private readonly env: Readonly<Record<string, string | undefined>>;
  private unread: ReadonlySet<string> = new Set();

  private constructor(declared: ReadonlySet<string>, env: Record<string, string | undefined>) {
    this.declared = declared;
    this.env = env;
  }

  /**
   * Validates every declared key; throws ConfigErrors listing all problems. `unreadSecrets` are validated as
   * paths but their files are not opened: the serve entry point never reads PG_OWNER_PASSWORD_FILE (P10.12).
   */
  static load(manifest: Manifest, env: Record<string, string | undefined>, o: { unreadSecrets?: string[] } = {}): Config {
    const c = new Config(new Set(Object.keys(manifest.properties)), { ...env });
    c.unread = new Set(o.unreadSecrets ?? []);
    const errors: ConfigError[] = [];
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof ConfigError) errors.push(e);
        else throw e;
      }
    };
    for (const [key, item] of Object.entries(manifest.properties)) {
      attempt(() => c.loadKey(key, item, manifest.required.includes(key)));
    }
    for (const [key] of Object.entries(manifest.properties)) attempt(() => c.applyFallback(key));
    for (const dep of manifest.dependencies) {
      for (const port of ["", ...Object.keys(manifest.extraPorts)]) {
        attempt(() => endpointValue(endpointName(dep.id, port), env[endpointName(dep.id, port)]));
      }
    }
    if (errors.length > 0) throw new ConfigErrors(errors);
    return c;
  }

  private loadKey(key: string, item: SchemaItem, required: boolean): void {
    validateKeyDeclaration(key, { secret: item.secret, mount: item.mount, type: item.type });
    const cat = catalogueKey(key);
    const spec: KeySpec = {
      format: cat?.format ?? (item.enum ? "enum" : (item.type ?? "string")),
      required,
      secret: item.secret === true,
      default: item.default === undefined || item.default === null ? (cat?.default ?? null) : String(item.default),
      schemes: cat?.schemes,
      enum: item.enum ?? cat?.enum,
      minimum: item.minimum,
      jsonKind: cat?.format === "json" ? "object" : undefined,
    };
    if (spec.format === "number") spec.format = "int";
    const raw = this.env[key];
    const parsed = parseValue(key, spec, raw === "" && spec.default === "" ? undefined : raw);
    if (!parsed.set) return;
    if (parsed.secretPath !== undefined && !this.unread.has(key)) this.secrets.set(key, new Secret(key, parsed.secretPath));
    if ((FAMILY_KEYS as readonly string[]).includes(key)) familyAddress(key, parsed.value as string);
    this.values.set(key, parsed.value);
  }

  private applyFallback(key: string): void {
    const cat = catalogueKey(key);
    if (this.values.has(key) || !cat) return;
    if (cat.default_from && this.values.has(cat.default_from)) this.values.set(key, this.values.get(cat.default_from));
    const group = cat.one_of?.filter((k) => this.declared.has(k)) ?? [];
    if (group[0] === key && group.every((k) => !this.values.has(k))) {
      throw new ConfigError("CONFIG_MISSING", key, `one of ${group.join(", ")} is required`);
    }
  }

  private get(key: string): unknown {
    checkReadable(key, this.declared);
    if (isPlatformName(key) && !this.declared.has(key)) return this.env[key];
    return this.values.get(key);
  }

  /** Whether the component's configSchema declares the key (SDK code reading an optional protocol key). */
  declares(key: string): boolean {
    return this.declared.has(key);
  }

  /** A protocol key's value when declared, else `def` (the catalogue default): for profiles the component does not use. */
  orDefault<T>(key: string, read: (c: Config) => T, def: T): T {
    return this.declared.has(key) ? read(this) : def;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  require(key: string): string {
    const v = this.get(key);
    if (v === undefined) throw new ConfigError("CONFIG_MISSING", key, "required and not set");
    return String(v);
  }

  string(key: string, def?: string): string | undefined {
    const v = this.get(key);
    return v === undefined ? def : String(v);
  }

  int(key: string, def?: number): number {
    return (this.get(key) as number | undefined) ?? def ?? 0;
  }

  bool(key: string, def = false): boolean {
    return (this.get(key) as boolean | undefined) ?? def;
  }

  /** milliseconds */
  duration(key: string, defMs = 0): number {
    const v = this.get(key) as bigint | undefined;
    return v === undefined ? defMs : nsToMs(v);
  }

  /** milliseconds */
  durations(key: string): number[] {
    return ((this.get(key) as bigint[] | undefined) ?? []).map(nsToMs);
  }

  json<T>(key: string): T | undefined {
    return this.get(key) as T | undefined;
  }

  secret(key: string): Secret {
    checkReadable(key, this.declared);
    const s = this.secrets.get(key);
    if (!s) throw new ConfigError(key.endsWith("_FILE") ? "CONFIG_MISSING" : "CONFIG_UNDECLARED", key, `${key} is not a secret that is set`);
    return s;
  }

  allSecrets(): Secret[] {
    return [...this.secrets.values()];
  }

  /** host:port of a dependency's port, from its `*_ENDPOINT` variable; undefined when not installed (P2.5). */
  endpoint(dependency: string, port = ""): string | undefined {
    const name = endpointName(dependency, port);
    return endpointValue(name, this.env[name]);
  }

  /** `http://host:port` for `*_URL`, `host:port` for `*_GRPC_URL`; undefined when the family member does not run. */
  familyAddress(key: (typeof FAMILY_KEYS)[number]): string | undefined {
    const v = this.declared.has(key) ? (this.values.get(key) as string | undefined) : undefined;
    return familyAddress(key, v);
  }
}

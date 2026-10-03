// Error catalogues (P4.4): schemas/errors-be.yaml for domain `be`, plus each component's contracts/errors.yaml.
// Titles and messages are templates in zh and en; the deployment's DEFAULT_LOCALE picks one (P4.1).
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { readProtocolYaml } from "../protocolFiles.js";

export interface CatalogEntry {
  reason: string;
  code: string;
  http: number;
  title: Record<string, string>;
  message: Record<string, string>;
}

interface CatalogFile {
  domain?: string;
  reasons: CatalogEntry[];
}

export class ErrorCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  add(domain: string, file: CatalogFile): this {
    for (const r of file.reasons ?? []) this.entries.set(`${domain}\u0000${r.reason}`, r);
    return this;
  }

  get(domain: string, reason: string): CatalogEntry | undefined {
    const own = this.entries.get(`${domain}\u0000${reason}`);
    if (own || domain !== "be" || this === be) return own;
    return beCatalog().get("be", reason);
  }

  /** Renders `title` / `message` of an entry in a locale, filling `{param}` from metadata. */
  render(domain: string, reason: string, locale: string, metadata: Record<string, string>): { title?: string; detail?: string } {
    const e = this.get(domain, reason);
    if (!e) return {};
    const lang = langOf(locale);
    const fill = (t: string | undefined) => t?.replace(/\{([a-z_][a-z0-9_]*)\}/g, (m, k: string) => metadata[k] ?? m);
    return { title: fill(e.title[lang] ?? e.title.en), detail: fill(e.message[lang] ?? e.message.en) };
  }
}

export function langOf(locale: string): "zh" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let be: ErrorCatalog | undefined;

/**
 * Reasons ruled after be-protocol rc.1 (stage-B review: 33 → 35 reasons), used only while the pinned
 * errors-be.yaml lacks them; the pinned file wins as soon as it carries them (rc.2).
 */
const RULED_AFTER_RC1: CatalogEntry[] = [
  {
    reason: "REQUEST_INVALID", code: "INVALID_ARGUMENT", http: 400,
    title: { en: "Invalid request", zh: "请求无效" },
    message: { en: "The request does not match the contract.", zh: "请求不符合接口约定。" },
  },
  {
    reason: "DEPENDENCY_UNAVAILABLE", code: "UNAVAILABLE", http: 503,
    title: { en: "Service unavailable", zh: "服务暂不可用" },
    message: { en: "A service this one depends on cannot be reached right now. Try again shortly.", zh: "所依赖的服务暂时无法访问，请稍后再试。" },
  },
];

/** The reserved reasons of domain `be`; read once, immutable, shared by every member. */
export function beCatalog(): ErrorCatalog {
  if (be) return be;
  const file = readProtocolYaml<CatalogFile>("schemas/errors-be.yaml");
  const pinned = new Set(file.reasons.map((r) => r.reason));
  be = new ErrorCatalog().add("be", { reasons: [...RULED_AFTER_RC1.filter((r) => !pinned.has(r.reason)), ...file.reasons] });
  return be;
}

/** A component's catalogue: its contracts/errors.yaml when present, the reserved reasons always. */
export function componentCatalog(componentId: string, errorsYamlPath: string | undefined): ErrorCatalog {
  const c = new ErrorCatalog();
  if (errorsYamlPath && existsSync(errorsYamlPath)) c.add(componentId, parse(readFileSync(errorsYamlPath, "utf8")) as CatalogFile);
  return c;
}

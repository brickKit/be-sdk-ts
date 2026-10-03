// The protocol's configuration-key catalogue (schemas/config-keys.yaml): how a protocol key is parsed.
import { readProtocolYaml } from "../protocolFiles.js";

export interface CatalogueKey {
  name: string;
  type: string;
  format: string;
  required: boolean;
  default: string | null;
  default_from?: string;
  one_of?: string[];
  schemes?: string[];
  enum?: string[];
  secret: boolean;
}

let keys: Map<string, CatalogueKey> | undefined;

export function catalogueKey(name: string): CatalogueKey | undefined {
  keys ??= new Map(readProtocolYaml<{ keys: CatalogueKey[] }>("schemas/config-keys.yaml").keys.map((k) => [k.name, k]));
  return keys.get(name);
}

import { describe } from "vitest";
import { runVectors } from "../../support/vectors.js";
import { parseValue, secretText } from "../../../src/config/parse.js";
import { checkReadable } from "../../../src/config/config.js";
import { endpointName, endpointValue, familyAddress } from "../../../src/config/endpoints.js";
import { validateKeyDeclaration, validateKeyName } from "../../../src/config/keys.js";

describe("config vectors", () => {
  runVectors("config", "values", {
    parse_value: (i) => {
      const r = parseValue("KEY", {
        format: i.type, required: i.required ?? false, secret: i.secret ?? false, default: i.default,
        minimum: i.minimum, schemes: i.schemes, jsonKind: i.json_kind, enum: i.enum,
      }, i.value ?? undefined);
      if (!r.set) return { set: false };
      if (r.secretPath !== undefined) return { set: true, source: "file", path: r.secretPath };
      return { set: true, value: typeof r.value === "bigint" ? String(r.value) : Array.isArray(r.value) && typeof r.value[0] === "bigint" ? r.value.map(String) : r.value };
    },
    read_undeclared: (i) => (checkReadable(i.key, new Set(i.declared)), { allowed: true }),
    secret_text: (i) => {
      const v = secretText("KEY", i.content, i.required);
      return v === undefined ? { set: false } : { set: true, value: v };
    },
  });
  runVectors("config", "endpoints", {
    endpoint_name: (i) => ({ name: endpointName(i.dependency, i.port) }),
    endpoint_value: (i) => {
      const a = endpointValue("X_ENDPOINT", i.value ?? undefined);
      return a === undefined ? { present: false } : { present: true, address: a };
    },
    family_address: (i) => {
      const a = familyAddress(i.key, i.value ?? undefined);
      if (a === undefined) return { present: false };
      return i.key.endsWith("_GRPC_URL") ? { present: true, target: a } : { present: true, base: a };
    },
  });
  runVectors("config", "keys", {
    key_name: (i) => (validateKeyName(i.key), { valid: true }),
    key_declaration: (i) => (validateKeyDeclaration(i.key, { secret: i.secret, mount: i.mount, type: i.type }), { valid: true }),
  });
});

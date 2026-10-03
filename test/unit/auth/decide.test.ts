// contract-infra-authz decision vectors (EVALUATION.md E1–E5): bundle acceptance, token checks, has(K).
// Levels, dimensions, subjects and single-record decisions (E6–E12) belong to the Access task (T6).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptBundle, checkToken, hasKey } from "../../../src/auth/decide.js";

const dir = fileURLToPath(new URL("../../../protocol/authz/decision/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("authz decision vectors (E1–E5)", () => {
  it("has vectors", () => expect(files.length).toBeGreaterThan(50));
  for (const f of files) {
    const v = JSON.parse(readFileSync(dir + f, "utf8"));
    it(v.id, () => {
      const b = acceptBundle(v.input.bundle);
      expect(b ? "accepted" : "refused").toBe(v.expected.bundle);
      if (!b) return;
      const claims = v.input.claims;
      const token = checkToken(b, claims);
      expect(token).toBe(v.expected.token);
      if (token !== "OK" || v.expected.has_key === undefined) return;
      expect(hasKey(b, claims, v.input.key, v.input.now)).toBe(v.expected.has_key);
    });
  }
});

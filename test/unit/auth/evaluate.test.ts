// contract-infra-authz decision vectors, every expected member (EVALUATION.md E1–E12): bundle, token, has_key,
// level, scope_params, degraded, fields, decision, explain. The whole `expected` object is compared, so a member
// computed but absent from the vector (or the reverse) fails too.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptBundle, checkToken } from "../../../src/auth/decide.js";
import { Evaluator, likeMatch, likePrefix, validDept, type ResourceType } from "../../../src/auth/evaluate.js";

const dir = fileURLToPath(new URL("../../../protocol/authz/decision/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

/** Computes the `expected` object of a vector from its input. */
function evaluateVector(input: any): Record<string, unknown> {
  const b = acceptBundle(input.bundle);
  if (!b) return { bundle: "refused" };
  const token = checkToken(b, input.claims);
  if (token !== "OK") return { bundle: "accepted", token };
  const ev = new Evaluator(b, input.claims, input.now);
  const t = input.resource_type as ResourceType;
  const { params, degraded } = ev.scope(t, input.key, input.graph_ids);
  const out: Record<string, unknown> = { bundle: "accepted", token, has_key: ev.has(input.key), level: ev.level(input.key), scope_params: params, degraded };
  if (t.fields?.length) {
    const f = ev.fields(t);
    out.fields = { masked: f.masked, read_only: f.readOnly };
  }
  if (input.row) {
    const acl = input.acl ?? [];
    out.decision = ev.decide(t, input.key, input.row, acl, input.graph_ids);
    out.explain = ev.explain(t, input.key, input.row, acl, input.graph_ids);
  }
  return out;
}

describe("authz decision vectors (E1–E12), every member", () => {
  it("has all 62 vectors", () => expect(files.length).toBe(62));
  for (const f of files) {
    const v = JSON.parse(readFileSync(dir + f, "utf8"));
    it(v.id, () => expect(evaluateVector(v.input)).toEqual(v.expected));
  }
});

describe("department paths and LIKE prefixes (E6)", () => {
  it("validates paths", () => {
    for (const ok of ["/", "/1/", "/1/12/", "/a_b/c%d/"]) expect(validDept(ok), ok).toBe(true);
    for (const bad of ["", "1/", "/1", "//", "/1//2/", undefined]) expect(validDept(bad), String(bad)).toBe(false);
  });
  it("escapes backslash, percent and underscore, then appends %", () => {
    expect(likePrefix("/a_b/c%d/")).toBe("/a\\_b/c\\%d/%");
    expect(likePrefix("/x\\y/")).toBe("/x\\\\y/%");
    expect(likePrefix("/")).toBe("/%");
  });
  it("matches like PostgreSQL LIKE with backslash escape", () => {
    expect(likeMatch("/a_b/c%d/9/", likePrefix("/a_b/c%d/"))).toBe(true);
    expect(likeMatch("/aXb/cYd/", likePrefix("/a_b/c%d/"))).toBe(false);
    expect(likeMatch("/1/12/5/", "/1/12/%")).toBe(true);
    expect(likeMatch("/1/123/", "/1/12/%")).toBe(false);
    expect(likeMatch("/x\\y/z/", likePrefix("/x\\y/"))).toBe(true);
    expect(likeMatch("a\nb", "a_b")).toBe(true);
    expect(likeMatch("a.b", "a_b")).toBe(true);
    expect(likeMatch("aXb", "a.b")).toBe(false);
    expect(likeMatch("a-b(😀)", "a-b(_)")).toBe(true);
    expect(likeMatch("[x]^$|", "[x]^$|")).toBe(true);
  });
});

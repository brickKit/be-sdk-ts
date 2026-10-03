// P16 "Canonical unit digest": the encoding, the chain, and the SQL that produces the rows' text form.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chainDigest, digestSelectSql, UnitDigest } from "../../../src/lifecycle/digest.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

describe("canonical unit digest", () => {
  it("fields joined by 0x1F, rows by 0x1E, NULL as \\N, no trailing separator, SHA-256 of the whole", () => {
    const d = new UnitDigest();
    d.addRow(["1", "a b"]);
    d.addRow(["2", null]);
    const r = d.finish();
    expect(r.rows).toBe(2);
    expect(r.digest.equals(sha(Buffer.from("1\x1fa b\x1e2\x1f\\N", "utf8")))).toBe(true);
  });

  it("encodes text as UTF-8", () => {
    const d = new UnitDigest();
    d.addRow(["客户-7f3a"]);
    expect(d.finish().digest.equals(sha(Buffer.from("客户-7f3a", "utf8")))).toBe(true);
  });

  it("an empty unit is the SHA-256 of nothing", () => {
    expect(new UnitDigest().finish().digest.toString("hex")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("adding pre-encoded rows gives the same digest as adding fields", () => {
    const a = new UnitDigest();
    a.addRow(["x", null, "3"]);
    a.addRow(["y", "", "4"]);
    const b = new UnitDigest();
    b.addEncoded("x\x1f\\N\x1f3");
    b.addEncoded("y\x1f\x1f4");
    expect(a.finish().digest.equals(b.finish().digest)).toBe(true);
  });

  it("chain_n = SHA-256(chain_{n-1} ‖ unit_n); the first link starts from an empty chain", () => {
    const u1 = sha("u1");
    const u2 = sha("u2");
    const c1 = chainDigest(undefined, u1);
    expect(c1.equals(sha(u1))).toBe(true);
    expect(chainDigest(c1, u2).equals(sha(Buffer.concat([c1, u2])))).toBe(true);
  });

  it("the SQL casts every column to text in declared order and orders by the primary key, text keys bytewise", () => {
    const sql = digestSelectSql("widgets_p20261001",
      [{ name: "id", collatable: false }, { name: "name", collatable: true }, { name: "n", collatable: false }],
      [{ name: "name", collatable: true }, { name: "id", collatable: false }]);
    expect(sql).toContain(`COALESCE(("id")::text, '\\N')`);
    expect(sql.indexOf(`("id")::text`)).toBeLessThan(sql.indexOf(`("name")::text, '\\N'`));
    expect(sql).toContain(`chr(31)`);
    expect(sql).toContain(`FROM "widgets_p20261001"`);
    expect(sql).toMatch(/ORDER BY "name" COLLATE "C", "id"$/);
  });
});

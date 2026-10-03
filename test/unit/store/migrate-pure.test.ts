import { describe, expect, it } from "vitest";
import { migrationLockValue, fnv1a53 } from "../../../src/migrate/lockKey.js";
import { weekStartUtc, outboxWindow } from "../../../src/migrate/window.js";
import { sqlActions } from "../../../src/migrate/sqlLoader.js";

describe("migration lock key (r1-06)", () => {
  it("FNV-1a 64 truncated to 53 bits is exact in a JS number", () => {
    const v = fnv1a53("erp_sales:pgmigrations_erp_sales");
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
  it("matches the FNV-1a 64 reference value for a known input", () => {
    // FNV-1a 64 of "a" = 0xaf63dc4c8601ec8c; low 53 bits:
    expect(fnv1a53("a")).toBe(Number(0xaf63dc4c8601ec8cn & ((1n << 53n) - 1n)));
  });
  it("differs per schema and is not node-pg-migrate's shared constant", () => {
    const a = migrationLockValue("s_a");
    const b = migrationLockValue("s_b");
    expect(a).not.toBe(b);
    expect(a).not.toBe(7241865325823964);
    expect(migrationLockValue("s_a")).toBe(a);
  });
});

describe("outbox partition window (P16.6)", () => {
  it("weeks start on Monday 00:00 UTC", () => {
    expect(weekStartUtc(new Date("2026-10-03T12:00:00Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Saturday
    expect(weekStartUtc(new Date("2026-10-05T00:00:00Z")).toISOString()).toBe("2026-10-05T00:00:00.000Z"); // Monday
    expect(weekStartUtc(new Date("2026-10-04T23:59:59.999Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Sunday
  });
  it("is the current week and two ahead, named by their first day", () => {
    const w = outboxWindow(new Date("2026-10-03T12:00:00Z"));
    expect(w.map((p) => p.name)).toEqual(["besdk_outbox_2026w40", "besdk_outbox_2026w41", "besdk_outbox_2026w42"]);
    expect(w[0]!.from.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(w[0]!.to.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(w[2]!.to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
  it("crosses a year boundary", () => {
    const w = outboxWindow(new Date("2026-12-31T08:00:00Z"));
    expect(w.map((p) => p.name)).toEqual(["besdk_outbox_2026w53", "besdk_outbox_2027w01", "besdk_outbox_2027w02"]);
  });
});

describe("SQL migration loader", () => {
  it("splits up and down sections like node-pg-migrate", () => {
    const a = sqlActions("-- Up Migration\nCREATE TABLE t (id int);\n-- Down Migration\nDROP TABLE t;\n");
    expect(a.up.sql).toContain("CREATE TABLE t");
    expect(a.up.sql).not.toContain("DROP TABLE");
    expect(a.down?.sql).toContain("DROP TABLE t");
    expect(a.noTransaction).toBe(false);
  });
  it("a file without markers is all up and has no down", () => {
    const a = sqlActions("CREATE TABLE t (id int);\n");
    expect(a.up.sql).toContain("CREATE TABLE t");
    expect(a.down).toBeUndefined();
  });
  it("honours the -- be:no-transaction header (P11.4)", () => {
    expect(sqlActions("-- be:no-transaction\n-- Up Migration\nCREATE INDEX CONCURRENTLY i ON t (id);\n").noTransaction).toBe(true);
    expect(sqlActions("-- Up Migration\n-- be:no-transaction\nSELECT 1;\n").noTransaction).toBe(false);
  });
});

import { rangePartition } from "../../../src/migrate/window.js";

describe("partition names (P16.10)", () => {
  it("are <parent>_<ISO week-year>w<WW>, <parent>_<YYYY>m<MM>, <parent>_<YYYY> from the lower bound", () => {
    expect(rangePartition("besdk_outbox", "week", new Date("2026-09-28T00:00:00Z")).name).toBe("besdk_outbox_2026w40");
    expect(rangePartition("t", "week", new Date("2024-12-30T00:00:00Z")).name).toBe("t_2025w01");
    expect(rangePartition("t", "month", new Date("2026-03-01T00:00:00Z")).name).toBe("t_2026m03");
    expect(rangePartition("t", "year", new Date("2027-01-01T00:00:00Z")).name).toBe("t_2027");
  });
});

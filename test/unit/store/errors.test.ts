import { describe, expect, it } from "vitest";
import { BeError, platformError } from "../../../src/errors/beError.js";
import { isConnectionError, isLockTimeout, isUniqueViolation, sqlStateOf } from "../../../src/store/errors.js";

const pgErr = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`pg ${code}`), { code, severity: "ERROR", ...extra });

describe("database error helpers", () => {
  it("reads the SQLSTATE of a driver error, or of the cause of a BeError", () => {
    expect(sqlStateOf(pgErr("23505"))).toBe("23505");
    expect(sqlStateOf(platformError("LOCK_TIMEOUT", undefined, "x", pgErr("55P03")))).toBe("55P03");
    expect(sqlStateOf(new Error("plain"))).toBeUndefined();
    expect(sqlStateOf(Object.assign(new Error("net"), { code: "ECONNRESET" }))).toBeUndefined();
  });
  it("isUniqueViolation / isLockTimeout look at the SQLSTATE", () => {
    expect(isUniqueViolation(pgErr("23505"))).toBe(true);
    expect(isUniqueViolation(new BeError("INTERNAL", "INTERNAL", { cause: pgErr("23505") }))).toBe(true);
    expect(isUniqueViolation(pgErr("23503"))).toBe(false);
    expect(isLockTimeout(platformError("LOCK_TIMEOUT", undefined, "x", pgErr("55P03")))).toBe(true);
    expect(isLockTimeout(pgErr("57014"))).toBe(false);
  });
  it("a connection-level failure is told apart from a statement error", () => {
    expect(isConnectionError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isConnectionError(pgErr("57P01", { severity: "FATAL" }))).toBe(true);
    expect(isConnectionError(pgErr("08006"))).toBe(true);
    expect(isConnectionError(pgErr("23505"))).toBe(false);
    expect(isConnectionError(pgErr("40001"))).toBe(false);
  });
});

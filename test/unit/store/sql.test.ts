import { describe, expect, it } from "vitest";
import {
  capStatementTimeout,
  lockSql,
  prefixSql,
  preambleSql,
  quoteIdent,
  quoteLiteral,
} from "../../../src/store/sql.js";

describe("quoting", () => {
  it("quotes identifiers, doubling embedded quotes", () => {
    expect(quoteIdent("sales")).toBe('"sales"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteIdent("Upper Case")).toBe('"Upper Case"');
  });
  it("quotes literals, doubling embedded single quotes", () => {
    expect(quoteLiteral("erp/sales")).toBe("'erp/sales'");
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  });
  it("refuses NUL bytes", () => {
    expect(() => quoteIdent("a\0b")).toThrow();
    expect(() => quoteLiteral("a\0b")).toThrow();
  });
});

describe("prefixSql (P10.2)", () => {
  it("puts the member's schema comment in front of every statement", () => {
    expect(prefixSql("erp_sales", "SELECT 1")).toBe("/* be:erp_sales */ SELECT 1");
  });
  it("cannot be closed early by a hostile schema name", () => {
    const s = prefixSql("x*/ DROP TABLE t; /*", "SELECT 1");
    expect(s.indexOf("*/")).toBe(s.lastIndexOf("*/"));
    expect(s.endsWith("*/ SELECT 1")).toBe(true);
  });
});

describe("capStatementTimeout (P10.3)", () => {
  it("is min(5 s, remaining) by default", () => {
    expect(capStatementTimeout({ remainingMs: 60_000 })).toBe(5_000);
    expect(capStatementTimeout({ remainingMs: 1_234 })).toBe(1_234);
  });
  it("honours a smaller request and caps a larger one at 5 s", () => {
    expect(capStatementTimeout({ remainingMs: 60_000, requestedMs: 800 })).toBe(800);
    expect(capStatementTimeout({ remainingMs: 60_000, requestedMs: 20_000 })).toBe(5_000);
  });
  it("allows up to 30 s for a read snapshot", () => {
    expect(capStatementTimeout({ remainingMs: 60_000, snapshot: true })).toBe(30_000);
    expect(capStatementTimeout({ remainingMs: 60_000, snapshot: true, requestedMs: 90_000 })).toBe(30_000);
    expect(capStatementTimeout({ remainingMs: 7_000, snapshot: true })).toBe(7_000);
  });
  it("never returns 0 (which would disable the timeout) for a positive remainder", () => {
    expect(capStatementTimeout({ remainingMs: 0.4 })).toBe(1);
  });
});

describe("preambleSql (P10.2, P10.3)", () => {
  const base = {
    isolation: "read committed" as const,
    readOnly: false,
    role: "sales_rt",
    schema: "erp_sales",
    applicationName: "erp/sales",
    statementTimeoutMs: 5000,
    lockTimeoutMs: 2000,
    idleTimeoutMs: 30000,
  };
  it("sends exactly the block of 'What every transaction sends', identifiers quoted", () => {
    expect(preambleSql(base)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      'SET LOCAL ROLE "sales_rt"',
      'SET LOCAL search_path TO "erp_sales"',
      "SET LOCAL application_name = 'erp/sales'",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '2000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    ]);
  });
  it("adds READ ONLY, the asked isolation and transaction_timeout when given", () => {
    const s = preambleSql({ ...base, isolation: "repeatable read", readOnly: true, transactionTimeoutMs: 4321 });
    expect(s[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(s.at(-1)).toBe("SET LOCAL transaction_timeout = '4321ms'");
    expect(preambleSql({ ...base, isolation: "serializable" })[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
  });
  it("never issues a session-level SET", () => {
    for (const s of preambleSql({ ...base, transactionTimeoutMs: 1 })) {
      if (s.startsWith("SET")) expect(s.startsWith("SET LOCAL ")).toBe(true);
    }
  });
});

describe("lockSql (P10.8)", () => {
  it("is a transaction-level advisory lock keyed by schema + name and the joined parts", () => {
    expect(lockSql(false)).toBe("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':' || $1), hashtext($2))");
    expect(lockSql(true)).toBe("SELECT pg_try_advisory_xact_lock(hashtext(current_schema() || ':' || $1), hashtext($2)) AS locked");
  });
});

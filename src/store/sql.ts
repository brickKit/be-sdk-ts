// The SQL text the store sends around a component's statements (P10.2, P10.3, P10.8): identifier and
// literal quoting, the per-member prefix comment, the SET LOCAL block that opens every transaction and the
// statement-timeout cap. Pure functions, so the exact wire text is unit-tested.

export type Isolation = "read committed" | "repeatable read" | "serializable";

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const SNAPSHOT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

function noNul(s: string): string {
  if (s.includes("\0")) throw new Error("SQL names and literals cannot contain NUL");
  return s;
}

/** A SQL identifier, always quoted, so a configured role or schema name is taken literally. */
export function quoteIdent(name: string): string {
  return `"${noNul(name).replaceAll('"', '""')}"`;
}

/** A SQL string literal (standard_conforming_strings is on since PostgreSQL 9.1). */
export function quoteLiteral(value: string): string {
  return `'${noNul(value).replaceAll("'", "''")}'`;
}

/**
 * `/* be:<schema> *\/ ` in front of every statement: keeps per-connection statement caches keyed by member
 * and attributes statements in pg_stat_activity. A `*\/` inside the name is broken up so it cannot end
 * the comment.
 */
export function prefixSql(schema: string, sql: string): string {
  return `/* be:${schema.replaceAll("*/", "* /")} */ ${sql}`;
}

/** min(requested or default, cap, remaining deadline); never 0, which would disable the timeout. */
export function capStatementTimeout(o: { remainingMs: number; requestedMs?: number; snapshot?: boolean }): number {
  const cap = o.snapshot ? SNAPSHOT_STATEMENT_TIMEOUT_MS : DEFAULT_STATEMENT_TIMEOUT_MS;
  const wanted = Math.min(o.requestedMs ?? cap, cap);
  return Math.max(1, Math.floor(Math.min(wanted, o.remainingMs)));
}

export interface Preamble {
  isolation: Isolation;
  readOnly: boolean;
  role: string;
  schema: string;
  applicationName: string;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleTimeoutMs: number;
  /** PostgreSQL 17 or later only */
  transactionTimeoutMs?: number;
}

const ms = (n: number) => quoteLiteral(`${Math.max(1, Math.floor(n))}ms`);

/** The statements of P10 "What every transaction sends", in order. */
export function preambleSql(p: Preamble): string[] {
  const out = [
    `BEGIN ISOLATION LEVEL ${p.isolation.toUpperCase()}${p.readOnly ? " READ ONLY" : ""}`,
    `SET LOCAL ROLE ${quoteIdent(p.role)}`,
    `SET LOCAL search_path TO ${quoteIdent(p.schema)}`,
    `SET LOCAL application_name = ${quoteLiteral(p.applicationName)}`,
    `SET LOCAL statement_timeout = ${ms(p.statementTimeoutMs)}`,
    `SET LOCAL lock_timeout = ${ms(p.lockTimeoutMs)}`,
    `SET LOCAL idle_in_transaction_session_timeout = ${ms(p.idleTimeoutMs)}`,
  ];
  if (p.transactionTimeoutMs !== undefined) out.push(`SET LOCAL transaction_timeout = ${ms(p.transactionTimeoutMs)}`);
  return out;
}

export function statementTimeoutSql(timeoutMs: number): string {
  return `SET LOCAL statement_timeout = ${ms(timeoutMs)}`;
}

/** P10.8: transaction-level advisory lock; $1 = name, $2 = parts joined by '|'. */
export function lockSql(tryOnly: boolean): string {
  const key = "hashtext(current_schema() || ':' || $1), hashtext($2)";
  return tryOnly ? `SELECT pg_try_advisory_xact_lock(${key}) AS locked` : `SELECT pg_advisory_xact_lock(${key})`;
}

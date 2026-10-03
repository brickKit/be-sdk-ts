// What a module declares as background work (P14, sdk-redesign-apis §2.9 in TS shape): jobs (every, singleton,
// cron), queue workers and reconcilers. Every run has a timeout; handlers are idempotent (P14.7).
import type { Tx } from "../store/tx.js";

export interface RunInfo {
  /** cron: the slot this run belongs to */
  slotAt?: Date;
  /** singleton: the lease's fencing token */
  epoch?: number;
}

export interface Job {
  /** unique within the component; metrics, leases, logs and JOBS_OVERRIDES use it */
  name: string;
  kind: "every" | "singleton" | "cron";
  /** every / singleton */
  intervalMs?: number;
  /** cron: five fields, or "@every <Go duration>" (≥ 1 s) */
  cron?: string;
  /** IANA zone of the cron schedule; default BUSINESS_TIMEZONE */
  tz?: string;
  /** required: the run is cancelled at it */
  timeoutMs: number;
  run: (signal: AbortSignal, info: RunInfo) => Promise<void>;
}

export interface QueuedJob {
  id: string;
  kind: string;
  args: unknown;
  /** this execution's number, from 1 */
  attempts: number;
  uniqueKey: string | null;
}

export interface Worker {
  /** the kind tx.enqueue names */
  kind: string;
  /** jobs of this kind run at once in this process; default 1 */
  concurrency?: number;
  /** default 8 */
  maxAttempts?: number;
  /** delays before attempt 2, 3, …; the last repeats; default 1s, 10s, 1m, 5m, 15m */
  backoffMs?: number[];
  timeoutMs: number;
  /** outside any transaction; idempotent on uniqueKey or a business key */
  run: (job: QueuedJob, signal: AbortSignal) => Promise<void>;
  /** attempts exhausted: the job is `dead`; runs in a transaction */
  onDead?: (tx: Tx, job: QueuedJob) => Promise<void>;
}

export interface Reconciler<T = any> {
  name: string;
  /** a pass every everyMs */
  everyMs: number;
  /** candidates per pass; default 50 */
  batch?: number;
  /** per handled item */
  timeoutMs: number;
  /** default 10 */
  maxAttempts?: number;
  /** default 10s, 1m, 5m, 15m, 1h */
  backoffMs?: number[];
  /** the component's own SQL: non-terminal and past its deadline */
  candidates: (tx: Tx, limit: number) => Promise<T[]>;
  id: (item: T) => string;
  /** outside any transaction; may call the network */
  handle: (item: T, signal: AbortSignal) => Promise<unknown>;
  /** a short transaction that re-checks the state machine; `false` = not settled yet (backs off and counts an attempt) */
  apply: (tx: Tx, item: T, outcome: any) => Promise<boolean | void>;
  /** past maxAttempts: suspend and open an exception task (tx.enqueue) */
  giveUp: (tx: Tx, item: T) => Promise<void>;
}

export interface JobsModule {
  jobs?: Job[];
  workers?: Worker[];
  reconcilers?: Reconciler[];
}

export interface Override {
  interval?: string;
  cron?: string;
  enabled?: boolean;
}

export type RunOnceResult = { result: "ok" | "noop" | "failed" | "unknown"; why?: string };

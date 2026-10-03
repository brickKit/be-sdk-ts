// One measured run of a piece of background work (P14.2, P14.3): its own unit of work (deadline = timeout,
// caller `system`), cancelled at the timeout or when the runtime stops, counted in be_job_runs_total{job,result}.
import type { Logger } from "pino";
import { runUnit, Unit } from "../context.js";
import { errorFields } from "../log/logger.js";
import type { MemberRegistry } from "../obs/metrics.js";

export type RunResult = "ok" | "error" | "timeout";

export interface RunDeps {
  memberId: string;
  logger: Logger;
  metrics: MemberRegistry;
  /** remembers each run's outcome for GET _ops/jobs */
  track?: (job: string, result: RunResult, error: string) => void;
}

/** Runs `fn` once under `timeoutMs`; never throws: the result is returned and counted. */
export async function measuredRun(d: RunDeps, job: string, timeoutMs: number, outer: AbortSignal, fn: (signal: AbortSignal) => Promise<void>): Promise<RunResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([outer, timeout]);
  const unit = new Unit({ memberId: d.memberId, deadline: Date.now() + timeoutMs, signal });
  unit.job = job;
  const t0 = performance.now();
  let result: RunResult;
  let error = "";
  try {
    await runUnit(unit, () => raceAbort(fn(signal), signal));
    result = timeout.aborted ? "timeout" : "ok";
  } catch (e) {
    result = timeout.aborted ? "timeout" : "error";
    error = String((e as Error)?.message ?? e).slice(0, 500);
    if (!outer.aborted) d.logger[result === "timeout" ? "warn" : "error"]({ job, ...errorFields(e) }, result === "timeout" ? "job_timeout" : "job_failed");
  }
  d.metrics.be.jobRuns.inc({ job, result });
  d.metrics.be.jobDuration.observe({ job }, (performance.now() - t0) / 1000);
  if (result === "ok") d.metrics.be.jobLastSuccess.set({ job }, Date.now() / 1000);
  d.track?.(job, result, error || result);
  return result;
}

const SETTLE_GRACE_MS = 1_000;

/**
 * At the abort the run gets SETTLE_GRACE_MS to notice its signal and return; a run that ignores it still ends for
 * the runtime then (its promise keeps running, detached), so a stuck handler cannot hold a lease or a slot forever.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const t = setTimeout(() => reject(signal.reason), SETTLE_GRACE_MS);
      p.finally(() => clearTimeout(t)).then(() => reject(signal.reason), () => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

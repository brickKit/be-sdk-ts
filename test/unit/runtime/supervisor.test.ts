import { describe, expect, it } from "vitest";
import { Supervisor } from "../../../src/runtime/supervisor.js";
import { Readiness } from "../../../src/runtime/readiness.js";
import { captureLogger } from "../../support/capture.js";

describe("Supervisor (P1.7)", () => {
  it("restarts a failing task with backoff and keeps the others running", async () => {
    const { logger, lines } = captureLogger();
    const sup = new Supervisor(logger, { initialBackoffMs: 10, maxBackoffMs: 40 });
    let failing = 0;
    let steady = 0;
    sup.run("be.flaky", async () => {
      failing++;
      throw new Error("boom");
    });
    sup.run("be.steady", async (signal) => {
      while (!signal.aborted) {
        steady++;
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(failing).toBeGreaterThanOrEqual(3);
    expect(failing).toBeLessThan(10); // backoff, not a hot loop
    expect(steady).toBeGreaterThan(5);
    await sup.stop(1000);
    const n = steady;
    await new Promise((r) => setTimeout(r, 30));
    expect(steady).toBe(n);
    expect(lines.some((l) => l.level === "error" && l.task === "be.flaky" && l.error === "boom")).toBe(true);
  });

  it("restarts a task that returned while not stopped", async () => {
    const { logger } = captureLogger();
    const sup = new Supervisor(logger, { initialBackoffMs: 5, maxBackoffMs: 5 });
    let runs = 0;
    sup.run("be.returns", async () => void runs++);
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBeGreaterThan(2);
    await sup.stop(100);
  });
});

describe("Readiness (P1.4)", () => {
  it("waits for every condition, then latches", () => {
    const r = new Readiness(["bundle", "db_identity", "migrations"]);
    expect(r.state()).toEqual({ ok: false, waiting: ["bundle", "db_identity", "migrations"] });
    r.met("db_identity");
    r.met("bundle");
    expect(r.state().waiting).toEqual(["migrations"]);
    r.met("migrations");
    expect(r.state()).toEqual({ ok: true, waiting: [] });
    r.unmet("bundle");
    expect(r.state().ok).toBe(true);
  });
});

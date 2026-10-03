import { describe, expect, it } from "vitest";
import { Semaphore, SemaphoreTimeout } from "../../../src/store/semaphore.js";

describe("Semaphore (P10.5 per-member budget)", () => {
  it("hands out up to max permits at once", async () => {
    const s = new Semaphore(2);
    const a = await s.acquire(10);
    await s.acquire(10);
    expect(s.inUse).toBe(2);
    a();
    expect(s.inUse).toBe(1);
  });

  it("times out a waiter after the given wait", async () => {
    const s = new Semaphore(1);
    await s.acquire(10);
    const t0 = Date.now();
    await expect(s.acquire(50)).rejects.toBeInstanceOf(SemaphoreTimeout);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(s.waiting).toBe(0);
  });

  it("serves waiters in FIFO order when a permit is released", async () => {
    const s = new Semaphore(1);
    const first = await s.acquire(10);
    const order: number[] = [];
    const p1 = s.acquire(1000).then((r) => (order.push(1), r));
    const p2 = s.acquire(1000).then((r) => (order.push(2), r));
    first();
    (await p1)();
    (await p2)();
    expect(order).toEqual([1, 2]);
    expect(s.inUse).toBe(0);
  });

  it("a release is idempotent", async () => {
    const s = new Semaphore(1);
    const r = await s.acquire(10);
    r();
    r();
    expect(s.inUse).toBe(0);
    await s.acquire(10);
    expect(s.inUse).toBe(1);
  });

  it("an aborted signal cancels the wait", async () => {
    const s = new Semaphore(1);
    await s.acquire(10);
    const ac = new AbortController();
    const p = s.acquire(5_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(s.waiting).toBe(0);
  });

  it("a zero or negative wait fails at once when no permit is free", async () => {
    const s = new Semaphore(1);
    await s.acquire(0);
    await expect(s.acquire(0)).rejects.toBeInstanceOf(SemaphoreTimeout);
  });

  it("a timed-out waiter does not swallow a later release", async () => {
    const s = new Semaphore(1);
    const r = await s.acquire(10);
    await expect(s.acquire(10)).rejects.toBeInstanceOf(SemaphoreTimeout);
    r();
    await s.acquire(10);
    expect(s.inUse).toBe(1);
  });
});

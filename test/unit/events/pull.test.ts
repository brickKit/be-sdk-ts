// A consumer that stops must leave no pull request behind (P1.6, P12.5, P12.9).
//
// A pull request stays registered at the server until it expires. A message published after the instance
// stopped is handed to that request, which nobody reads, and is redelivered only after the ack wait (30 s).
// So the loop sends bounded pull requests, sends none once it stops, lets the running one end, and hands back
// at once whatever it still brings.
import { describe, expect, it } from "vitest";
import { FETCH_WAIT_MS, pullLoop, type PullSource } from "../../../src/events/bus/pull.js";
import { captureLogger } from "../../support/capture.js";

interface Msg {
  id: string;
  nak(delayMs?: number): void;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function settled(p: Promise<unknown>, withinMs: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), tick(withinMs).then(() => false)]);
}

/** A source whose fetches are scripted: each script entry is one pull request. */
function scripted(log: string[], script: Array<(max: number) => AsyncIterable<Msg>>) {
  const asks: Array<{ max: number; expiresMs: number }> = [];
  const idle = deferred();
  const src: PullSource<Msg> & { forgotten: number } = {
    forgotten: 0,
    async fetch(max, expiresMs) {
      asks.push({ max, expiresMs });
      log.push(`fetch(${max})`);
      const next = script.shift();
      if (next) return next(max);
      return (async function* () { await idle.promise; })(); // nothing more: stays in flight until the test ends
    },
    forget() {
      this.forgotten++;
    },
  };
  return { src, asks, end: () => idle.resolve() };
}

const msg = (log: string[], id: string): Msg => ({ id, nak: () => void log.push(`nak:${id}`) });

describe("pullLoop (P1.6, P12.9)", () => {
  it("stop waits for the running pull request to end and hands its messages back at once", async () => {
    const log: string[] = [];
    const gate = deferred();
    const { src, asks } = scripted(log, [
      () => (async function* () {
        await gate.promise;
        log.push("fetch-end");
        yield msg(log, "late");
      })(),
    ]);
    const ac = new AbortController();
    const loop = pullLoop(src, async (m) => void log.push(`handled:${m.id}`), { concurrency: 4, signal: ac.signal, logger: captureLogger().logger });
    await tick();

    ac.abort();
    expect(await settled(loop, 50), "the loop ended while a pull request was still waiting at the server").toBe(false);

    gate.resolve();
    await loop;
    expect(log).toEqual(["fetch(4)", "fetch-end", "nak:late"]); // no handler, no new fetch
    expect(FETCH_WAIT_MS).toBeLessThanOrEqual(1_000);
    expect(asks.every((a) => a.expiresMs === FETCH_WAIT_MS), "a pull request may outlive a stop by its expiry: keep it short").toBe(true);
  });

  it("asks only for the free slots and never runs more than `concurrency` handlers", async () => {
    const log: string[] = [];
    const release = new Map<string, () => void>();
    const handler = (m: Msg) => new Promise<void>((r) => { log.push(`start:${m.id}`); release.set(m.id, r); });
    const { src, asks, end } = scripted(log, [
      () => (async function* () { yield msg(log, "a"); yield msg(log, "b"); yield msg(log, "c"); })(),
      () => (async function* () { yield msg(log, "d"); })(),
    ]);
    const ac = new AbortController();
    const loop = pullLoop(src, handler, { concurrency: 4, signal: ac.signal, logger: captureLogger().logger });
    await tick();
    expect(asks.map((a) => a.max)).toEqual([4, 1]); // four busy: no third pull request
    expect(release.size).toBe(4);

    release.get("a")!();
    release.get("b")!();
    await tick();
    expect(asks.map((a) => a.max)).toEqual([4, 1, 2]);

    ac.abort();
    end();
    expect(await settled(loop, 50), "the loop ended before its handlers").toBe(false);
    release.get("c")!();
    release.get("d")!();
    await loop;
  });

  it("a failed pull request is logged once, the handle forgotten, and pulled again after the pause", async () => {
    const log: string[] = [];
    const cap = captureLogger();
    const boom = () => (async function* (): AsyncGenerator<Msg> { throw new Error("consumer deleted"); })();
    const { src, end } = scripted(log, [boom, boom, () => (async function* () { yield msg(log, "a"); })()]);
    const ac = new AbortController();
    const loop = pullLoop(src, async (m) => void log.push(`handled:${m.id}`), { concurrency: 2, signal: ac.signal, logger: cap.logger, retryDelayMs: 5 });
    await tick(60);
    expect(log.slice(0, 4)).toEqual(["fetch(2)", "fetch(2)", "fetch(2)", "handled:a"]);
    expect(src.forgotten).toBe(2);
    expect(cap.lines.filter((l) => l.msg === "consumer_fetch_failed").map((l) => [l.level, l.error])).toEqual([["warn", "consumer deleted"]]);
    expect(cap.lines.filter((l) => l.msg === "consumer_fetch_resumed")).toHaveLength(1);
    ac.abort();
    end();
    await loop;
  });

  it("a handler that throws is logged and the loop goes on", async () => {
    const log: string[] = [];
    const cap = captureLogger();
    const { src, end } = scripted(log, [() => (async function* () { yield msg(log, "a"); yield msg(log, "b"); })()]);
    const ac = new AbortController();
    const loop = pullLoop(src, async (m) => {
      if (m.id === "a") throw new Error("bug");
      log.push(`handled:${m.id}`);
    }, { concurrency: 1, signal: ac.signal, logger: cap.logger });
    await tick();
    expect(log).toContain("handled:b");
    expect(cap.lines.some((l) => l.level === "error" && l.msg === "consumer_handler_crashed" && l.error === "bug")).toBe(true);
    ac.abort();
    end();
    await loop;
  });
});

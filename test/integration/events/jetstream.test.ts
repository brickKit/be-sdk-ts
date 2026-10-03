import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jetstreamManager } from "@nats-io/jetstream";
import { JetStreamBus, type Delivery } from "../../../src/events/bus/jetstream.js";
import { captureLogger } from "../../support/capture.js";
import { requireEnv } from "../../support/env.js";

const url = requireEnv("BE_TEST_NATS");
const log = captureLogger("sdktest/bus");
let bus: JetStreamBus;
const seg = `t${Date.now().toString(36)}`;
const subject = `${seg}.thing.created.v1`;
const durable = `sdktest_bus__${subject.split(".").join("__")}`;

beforeAll(async () => {
  bus = await JetStreamBus.connect({ url, name: "sdktest/bus", logger: log.logger });
});
afterAll(async () => bus.close());

const h = (id: string) => ({ "ce-id": id, "ce-type": subject });

describe("JetStreamBus (P12.4, P12.5, P12.13)", () => {
  it("creates the stream and the DLQ stream once, with the protocol defaults, and never changes them", async () => {
    await bus.ensureStream(subject);
    await bus.ensureStream(subject);
    const jsm = await jetstreamManager(bus.connection);
    const s = await jsm.streams.info(`BE_${seg.toUpperCase()}`);
    expect(s.config).toMatchObject({ subjects: [`${seg}.>`], max_bytes: 2 ** 30, discard: "old", storage: "file", num_replicas: 1 });
    expect(s.config.max_age).toBe(7 * 24 * 3600 * 1e9);
    expect(s.config.duplicate_window).toBe(600 * 1e9);
    await jsm.streams.update(`BE_${seg.toUpperCase()}`, { ...s.config, max_msgs: 1000 });
    await bus.ensureStream(subject);
    expect((await jsm.streams.info(`BE_${seg.toUpperCase()}`)).config.max_msgs).toBe(1000);
    const d = await jsm.streams.info("BE_DLQ");
    expect(d.config.subjects).toEqual(["dlq.>"]);
  });

  it("publishes with the message ID as the duplicate key and waits for the ack", async () => {
    await bus.publish(subject, h("01a0fba0-947b-77cc-9a52-3f1d2e4b5a60"), new TextEncoder().encode('{"a":1}'), "01a0fba0-947b-77cc-9a52-3f1d2e4b5a60");
    await bus.publish(subject, h("01a0fba0-947b-77cc-9a52-3f1d2e4b5a60"), new TextEncoder().encode('{"a":1}'), "01a0fba0-947b-77cc-9a52-3f1d2e4b5a60");
    const jsm = await jetstreamManager(bus.connection);
    expect((await jsm.streams.info(`BE_${seg.toUpperCase()}`)).state.messages).toBe(1);
  });

  it("creates a durable only when absent, with the protocol constants, and keeps an operator's change", async () => {
    expect(await bus.ensureDurable(durable, subject)).toEqual({ created: true, drift: [] });
    const jsm = await jetstreamManager(bus.connection);
    const c = (await jsm.consumers.info(`BE_${seg.toUpperCase()}`, durable)).config;
    expect(c).toMatchObject({ ack_policy: "explicit", deliver_policy: "all", max_ack_pending: 256, max_deliver: -1, filter_subject: subject });
    expect(c.ack_wait).toBe(30e9);
    expect(c.backoff ?? []).toEqual([]);
    expect(c.inactive_threshold).toBe(30 * 24 * 3600 * 1e9);
    await jsm.consumers.update(`BE_${seg.toUpperCase()}`, durable, { max_ack_pending: 100 });
    const again = await bus.ensureDurable(durable, subject);
    expect(again.created).toBe(false);
    expect(again.drift).toContain("max_ack_pending");
    expect((await jsm.consumers.info(`BE_${seg.toUpperCase()}`, durable)).config.max_ack_pending).toBe(100);
    expect(log.lines.some((l) => l.level === "warn" && l.durable === durable)).toBe(true);
  });

  it("delivers what was published before the durable existed (DeliverAll) and counts deliveries across naks", async () => {
    const seen: number[] = [];
    const ac = new AbortController();
    const loop = bus.consume(subject, durable, 4, async (d: Delivery) => {
      seen.push(d.deliveryCount);
      if (d.deliveryCount < 3) d.nak(50);
      else {
        d.ack();
        ac.abort();
      }
    }, ac.signal);
    await loop;
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops without a pull request left at the server and hands back what it had already been sent (P1.6)", async () => {
    const stopped = `${seg}.thing.stopped.v1`;
    const name = `sdktest_bus__${stopped.split(".").join("__")}`;
    const stream = `BE_${seg.toUpperCase()}`;
    await bus.ensureStream(stopped);
    await bus.ensureDurable(name, stopped);
    const jsm = await jetstreamManager(bus.connection);
    for (const n of [1, 2, 3, 4]) {
      const id = `01a0fba0-947b-77cc-9a52-3f1d2e4b5a7${n}`;
      await bus.publish(stopped, h(id), new TextEncoder().encode("{}"), id);
    }

    // four are sent for the four free slots; the instance stops while it handles the first
    const first: number[] = [];
    const ac = new AbortController();
    await bus.consume(stopped, name, 4, async (d: Delivery) => {
      first.push(d.streamSeq);
      d.ack();
      ac.abort();
    }, ac.signal);
    expect(first).toHaveLength(1);
    expect((await jsm.consumers.info(stream, name)).num_waiting).toBe(0);

    // the other three were handed back: the next consumer gets them at once, not after ack_wait (30 s)
    const rest: number[] = [];
    const again = new AbortController();
    const started = Date.now();
    await bus.consume(stopped, name, 4, async (d: Delivery) => {
      rest.push(d.deliveryCount);
      d.ack();
      if (rest.length === 3) again.abort();
    }, again.signal);
    expect(rest).toEqual([2, 2, 2]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps pulling an idle durable, one bounded request after another, without a failure", async () => {
    const idle = `${seg}.thing.idle.v1`;
    const name = `sdktest_bus__${idle.split(".").join("__")}`;
    await bus.ensureStream(idle);
    await bus.ensureDurable(name, idle);
    const ac = new AbortController();
    let deliveredAt = 0;
    const loop = bus.consume(idle, name, 4, async (d: Delivery) => {
      deliveredAt = Date.now();
      d.ack();
    }, ac.signal);
    await new Promise((r) => setTimeout(r, 3_500)); // three requests expire (FETCH_WAIT_MS each)
    const publishedAt = Date.now();
    await bus.publish(idle, h("01a0fba0-947b-77cc-9a52-3f1d2e4b5a80"), new TextEncoder().encode("{}"), "01a0fba0-947b-77cc-9a52-3f1d2e4b5a80");
    await expect.poll(() => deliveredAt, { timeout: 2_000 }).toBeGreaterThan(0);
    expect(deliveredAt - publishedAt).toBeLessThan(500);
    ac.abort();
    await loop;
    expect(log.lines.filter((l) => l.msg === "consumer_fetch_failed")).toEqual([]);
  });
});

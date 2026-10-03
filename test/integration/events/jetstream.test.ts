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
});

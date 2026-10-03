// Runs be-protocol vector files (protocol/vectors, synced by `make sync-protocol`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

export interface VectorCase {
  id: string;
  op: string;
  input: Record<string, any>;
  expected?: any;
  expected_error?: { reason: string };
}

const root = fileURLToPath(new URL("../../protocol/vectors/", import.meta.url));

export function loadCases(area: string, topic: string): VectorCase[] {
  return JSON.parse(readFileSync(`${root}${area}/${topic}.json`, "utf8")).cases as VectorCase[];
}

/** An operation either returns the expected shape or throws an error whose `vectorReason` (or `reason`) is checked. */
export type Op = (input: Record<string, any>, c: VectorCase) => unknown;

export function runVectors(area: string, topic: string, ops: Record<string, Op>): void {
  const cases = loadCases(area, topic);
  it(`${area}/${topic}: every op is implemented`, () => {
    const missing = [...new Set(cases.map((c) => c.op))].filter((op) => !(op in ops));
    expect(missing).toEqual([]);
  });
  for (const c of cases) {
    const op = ops[c.op];
    if (!op) continue;
    it(c.id, async () => {
      if (c.expected_error) {
        let thrown: any;
        try {
          await op(c.input, c);
        } catch (e) {
          thrown = e;
        }
        expect(thrown, "expected an error").toBeDefined();
        expect(thrown.vectorReason ?? thrown.reason).toBe(c.expected_error.reason);
      } else {
        expect(await op(c.input, c)).toEqual(c.expected);
      }
    });
  }
}

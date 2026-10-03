// be-protocol vectors idempotency/: the JCS fingerprint (P13.2), the decision for a key (P13.2–P13.4, P13.7),
// key resolution (P3.7), caller namespaces (P13.1) and expiry (P13.7).
import { describe } from "vitest";
import { callerNamespace, decideKey, expiresAt, resolveKey } from "../../../src/idempotency/decide.js";
import { canonicalJson, fingerprint } from "../../../src/idempotency/jcs.js";
import { runVectors } from "../../support/vectors.js";

const callerOf = (c: any) => (c.kind === "user" ? { kind: "user" as const, sub: c.sub } : c.kind === "system_call" ? { kind: "svc" as const, caller: c.be_caller } : { kind: "system" as const });

describe("idempotency vectors", () => {
  runVectors("idempotency", "fingerprint", {
    fingerprint: (i) => ({ canonical: canonicalJson(i.json_text), sha256: Buffer.from(fingerprint(i.json_text)).toString("hex") }),
  });
  runVectors("idempotency", "keys", {
    resolve_key: (i) => ({ key: resolveKey(i.header ?? undefined, i.body ?? undefined) ?? null }),
    caller_namespace: (i) => ({ caller: callerNamespace(callerOf(i.caller)) }),
    expires_at: (i) => ({ expires_at: expiresAt(i.created_at) }),
  });
  runVectors("idempotency", "decide", {
    decide: (i) => {
      const inc = i.incoming;
      const caller = callerNamespace(callerOf(inc.caller));
      const row = (i.rows as any[]).find((r) => r.caller === caller && r.idempotency_key === inc.key);
      const d = decideKey(row && { command: row.command, target: row.target, requestHash: row.request_hash, status: row.status, result: row.result, expiresAt: new Date(row.expires_at) },
        { command: inc.command, target: inc.target, requestHash: Buffer.from(fingerprint(inc.request)).toString("hex") }, new Date(i.now));
      if (d.outcome === "REJECT") return { caller, outcome: d.outcome, code: d.error.code, http: d.http, reason: d.error.reason };
      return d.outcome === "REPLAY" ? { caller, outcome: "REPLAY", result: d.result } : { caller, outcome: "EXECUTE" };
    },
  });
});

import { expect, it } from "vitest";
import { commandKey } from "../../../src/idempotency/decide.js";

describe("commandKey (P3.7)", () => {
  it("reads the Idempotency-Key header and the idempotency_key body field", () => {
    expect(commandKey({ headers: { "idempotency-key": "h1" }, body: {} })).toBe("h1");
    expect(commandKey({ headers: {}, body: { idempotency_key: "b1" } })).toBe("b1");
    expect(commandKey({ headers: {}, body: undefined })).toBe("");
    expect(() => commandKey({ headers: { "idempotency-key": "h1" }, body: { idempotency_key: "b2" } })).toThrow(/differ/);
  });
});
